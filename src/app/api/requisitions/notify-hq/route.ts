import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildHqRequisitionHtml,
  buildHqRequisitionSubject,
  buildHqRequisitionText,
} from "@/lib/requisitionNotificationEmail";

export const runtime = "nodejs";

type RequisitionRow = {
  id: string;
  location_id: string | null;
  location: string | null;
  requestedby: string | null;
  created_by: string | null;
  date: string | null;
  notes: string | null;
  total_amount: number | string | null;
  status: string | null;
  created_at?: string | null;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}

async function logNotification(adminClient: any, payload: Record<string, any>) {
  const { error } = await adminClient.from("requisition_email_logs").insert(payload);
  if (error) {
    console.error("[requisitions/notify-hq] email log insert failed", error);
  }
}

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  const hqEmail = process.env.HQ_ORDER_NOTIFICATION_EMAIL;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "StockIQ Orders <orders@stockiq.app>";

  if (!url || !anonKey || !serviceKey) {
    return jsonError("Supabase server environment variables are not configured.", 500);
  }
  if (!resendApiKey) return jsonError("RESEND_API_KEY is not configured.", 500);
  if (!hqEmail) return jsonError("HQ_ORDER_NOTIFICATION_EMAIL is not configured.", 500);

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) return jsonError("Missing auth token.", 401);

  const { requisitionId } = await req.json();
  if (!requisitionId || typeof requisitionId !== "string") {
    return jsonError("requisitionId is required.");
  }

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
  if (!["hq_master", "hq_ops", "hq_admin", "location_manager"].includes(profile.role)) {
    return jsonError("You do not have permission to send requisition notifications.", 403);
  }

  const { data: requisition, error: reqError } = await userClient
    .from("requisitions")
    .select("id,location_id,location,requestedby,created_by,date,notes,total_amount,status,created_at")
    .eq("id", requisitionId)
    .single<RequisitionRow>();

  if (reqError || !requisition) return jsonError("Requisition not found or not accessible.", 404);
  if (profile.role === "location_manager" && profile.location_id !== requisition.location_id) {
    return jsonError("You can only send notifications for your assigned location.", 403);
  }

  const { data: location } = requisition.location_id
    ? await adminClient.from("locations").select("id,name").eq("id", requisition.location_id).maybeSingle()
    : { data: null };

  const { data: lineItems, error: lineError } = await adminClient
    .from("requisition_items")
    .select("item_name_snapshot,unit_snapshot,quantity_requested,unit_price,line_total,inventory_items(name),hq_sale_items(name,base_unit)")
    .eq("requisition_id", requisition.id)
    .order("created_at", { ascending: true });

  if (lineError) {
    await logNotification(adminClient, {
      requisition_id: requisition.id,
      location_id: requisition.location_id,
      recipient_email: hqEmail,
      status: "failed",
      error: `Could not load line items: ${lineError.message}`,
      triggered_by: user.id,
    });
    return jsonError(`Could not load requisition line items: ${lineError.message}`, 500);
  }

  const submittedAt = requisition.created_at
    ? new Date(requisition.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const emailData = {
    requisitionId: requisition.id,
    locationName: location?.name || requisition.location || requisition.location_id || "Unknown location",
    submittedBy: profile.full_name || requisition.requestedby || user.email || null,
    submittedAt,
    requestedDeliveryDate: null,
    notes: requisition.notes,
    totalValue: requisition.total_amount,
    lineItems: Array.isArray(lineItems) ? lineItems : [],
  };

  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [hqEmail],
      subject: buildHqRequisitionSubject(emailData),
      html: buildHqRequisitionHtml(emailData),
      text: buildHqRequisitionText(emailData),
    }),
  });

  const resendBody = await resendResponse.json().catch(() => ({}));
  if (!resendResponse.ok) {
    const message = resendBody?.message || resendBody?.error || "Resend email request failed.";
    await logNotification(adminClient, {
      requisition_id: requisition.id,
      location_id: requisition.location_id,
      recipient_email: hqEmail,
      status: "failed",
      error: message,
      triggered_by: user.id,
    });
    return jsonError(message, 502);
  }

  await logNotification(adminClient, {
    requisition_id: requisition.id,
    location_id: requisition.location_id,
    recipient_email: hqEmail,
    status: "sent",
    provider_id: resendBody?.id ?? null,
    triggered_by: user.id,
  });

  return NextResponse.json({
    success: true,
    providerId: resendBody?.id ?? null,
  });
}
