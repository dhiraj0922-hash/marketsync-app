import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildSupplierOrderHtml,
  buildSupplierOrderSubject,
  buildSupplierOrderText,
} from "@/lib/purchaseOrderEmail";

export const runtime = "nodejs";

type OrderRow = {
  id: string;
  ponumber: string | null;
  supplierid: number | null;
  suppliername: string | null;
  deliverydate: string | null;
  lineitems: any[] | null;
  location: string | null;
  location_id: string | null;
  notes: string | null;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}

async function logEmailAttempt(
  adminClient: any,
  payload: Record<string, any>
) {
  const { error } = await adminClient.from("order_email_logs").insert(payload);
  if (error) {
    console.error("[purchase-orders/send] email log insert failed", error);
  }
}

async function markOrderEmailFailed(
  adminClient: any,
  orderId: string,
  message: string,
  logPayload?: Record<string, any>
) {
  await adminClient
    .from("orders")
    .update({ status: "Failed", email_error: message })
    .eq("id", orderId);
  if (logPayload) {
    await logEmailAttempt(adminClient, { ...logPayload, status: "failed", error: message });
  }
}

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "StockIQ Orders <orders@stockiq.app>";
  const replyTo = process.env.SUPPLIER_ORDER_REPLY_TO || process.env.RESEND_REPLY_TO || undefined;

  if (!url || !anonKey || !serviceKey) {
    return jsonError("Supabase server environment variables are not configured.", 500);
  }
  if (!resendApiKey) {
    return jsonError("RESEND_API_KEY is not configured.", 500);
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) return jsonError("Missing auth token.", 401);

  const { orderId } = await req.json();
  if (!orderId || typeof orderId !== "string") return jsonError("orderId is required.");

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser(token);
  if (userError || !user) return jsonError("Invalid auth token.", 401);

  const { data: profile, error: profileError } = await adminClient
    .from("user_profiles")
    .select("user_id, full_name, role, location_id, is_active")
    .eq("user_id", user.id)
    .single();

  if (profileError || !profile?.is_active) return jsonError("Active user profile not found.", 403);
  if (!["hq_admin", "location_manager"].includes(profile.role)) {
    return jsonError("You do not have permission to send supplier orders.", 403);
  }

  const { data: order, error: orderError } = await userClient
    .from("orders")
    .select("id,ponumber,supplierid,suppliername,deliverydate,lineitems,location,location_id,notes")
    .eq("id", orderId)
    .single<OrderRow>();

  if (orderError || !order) return jsonError("Order not found or not accessible.", 404);
  if (profile.role === "location_manager" && profile.location_id !== order.location_id) {
    return jsonError("You can only send orders for your assigned location.", 403);
  }
  if (!order.supplierid) {
    const message = "Order is missing a supplier.";
    await markOrderEmailFailed(adminClient, order.id, message);
    return jsonError(message);
  }

  const { data: supplier, error: supplierError } = await adminClient
    .from("suppliers")
    .select("id,name,email,contact")
    .eq("id", order.supplierid)
    .single();

  if (supplierError || !supplier) {
    const message = "Supplier not found.";
    await markOrderEmailFailed(adminClient, order.id, message);
    return jsonError(message, 404);
  }

  const { data: location } = order.location_id
    ? await adminClient.from("locations").select("id,name").eq("id", order.location_id).maybeSingle()
    : { data: null };

  const emailData = {
    poNumber: order.ponumber || order.id,
    supplierName: supplier.name || order.suppliername || "Supplier",
    locationName: location?.name || order.location || order.location_id || "StockIQ",
    deliveryDate: order.deliverydate,
    notes: order.notes,
    contactName: profile.full_name || user.email || null,
    replyTo,
    lineItems: Array.isArray(order.lineitems) ? order.lineitems : [],
  };

  const logBase = {
    order_id: order.id,
    supplier_id: supplier.id,
    supplier_email: supplier.email,
    provider: "resend",
    sent_by: user.id,
  };

  if (!supplier.email) {
    const message = `Supplier "${supplier.name}" does not have an email address.`;
    await markOrderEmailFailed(adminClient, order.id, message, logBase);
    return jsonError(message);
  }

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [supplier.email],
      reply_to: replyTo,
      subject: buildSupplierOrderSubject(emailData),
      html: buildSupplierOrderHtml(emailData),
      text: buildSupplierOrderText(emailData),
    }),
  });

  const resendBody = await resendResponse.json().catch(() => ({}));
  if (!resendResponse.ok) {
    const message = resendBody?.message || resendBody?.error || "Resend email request failed.";
    await markOrderEmailFailed(adminClient, order.id, message, logBase);
    return jsonError(message, 502);
  }

  const sentAt = new Date().toISOString();
  const { data: updatedOrder, error: updateError } = await adminClient
    .from("orders")
    .update({ status: "Sent", email_sent_at: sentAt, email_error: null })
    .eq("id", order.id)
    .select()
    .single();

  if (updateError) {
    await logEmailAttempt(adminClient, {
      ...logBase,
      status: "sent_update_failed",
      provider_id: resendBody?.id ?? null,
      error: updateError.message,
    });
    return jsonError(`Email sent, but order status update failed: ${updateError.message}`, 500);
  }

  await logEmailAttempt(adminClient, {
    ...logBase,
    status: "sent",
    provider_id: resendBody?.id ?? null,
  });

  return NextResponse.json({
    success: true,
    order: updatedOrder,
    providerId: resendBody?.id ?? null,
    emailSentAt: sentAt,
  });
}
