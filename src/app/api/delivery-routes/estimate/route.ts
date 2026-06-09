import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  updateDeliveryRunRouteEstimate,
  applyOptimizedStopOrder,
} from "@/lib/storage";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { runId, optimize, returnToStart } = body;

    console.log("[Route Estimate Body]", body);

    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    // 1. Check for API Key server-side
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.warn("GOOGLE_MAPS_API_KEY is missing from environment variables.");
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "Google Maps API key missing. Enter km/minutes manually.",
      });
    }

    // 2. Load delivery run directly. Avoid embedded relationship .single()
    // coercion; route estimation needs only the run snapshot fields here.
    let runRow = null;
    let runError = null;
    let lookupMode = "id";

    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(runId);
    if (isUuid) {
      const { data, error } = await supabase
        .from("delivery_runs")
        .select("*")
        .eq("id", runId)
        .maybeSingle();
      runRow = data;
      runError = error;
    }

    if (runError) {
      console.error("[Route Estimate Supabase Error UUID lookup]", runError);
    }

    if (!runRow) {
      lookupMode = "run_number";
      const { data, error } = await supabase
        .from("delivery_runs")
        .select("*")
        .eq("run_number", runId)
        .maybeSingle();
      runRow = data;
      if (error) {
        console.error("[Route Estimate Supabase Error run_number lookup]", error);
        runError = error;
      }
    }

    if (!runRow) {
      const errRes: any = { success: false, message: "Delivery run not found." };
      if (process.env.NODE_ENV === "development") {
        errRes.requestedRunId = runId;
        errRes.lookupMode = lookupMode;
      }
      return NextResponse.json(errRes, { status: 404 });
    }

    const run = {
      id: runRow.id,
      runNumber: runRow.run_number,
      startLocationName: runRow.start_location_name ?? "",
      startAddress: runRow.start_address ?? "",
      actualStartTime: runRow.actual_start_time ?? "",
    };

    // 3. Determine origin address
    let originAddress = run.startAddress?.trim();
    if (!originAddress) {
      // Fetch LOC-HQ location billing profile to get address details
      const { data: hqProfile } = await supabase
        .from("location_billing_profiles")
        .select("*")
        .eq("location_id", "LOC-HQ")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (hqProfile) {
        const storeAddress = hqProfile.store_address || hqProfile.storeAddress;
        const city = hqProfile.store_city || hqProfile.storeCity;
        const province = hqProfile.store_province || hqProfile.storeProvince;
        const postalCode = hqProfile.store_postal_code || hqProfile.storePostalCode;
        if (storeAddress) {
          originAddress = `${storeAddress}, ${city || ""}, ${province || ""} ${postalCode || ""}, Canada`
            .replace(/,\s*,/g, ",")
            .replace(/\s+/g, " ")
            .trim();
        }
      }

      if (!originAddress) {
        // Fall back to locations table metadata
        const { data: hqLoc } = await supabase
          .from("locations")
          .select("*")
          .eq("id", "LOC-HQ")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (hqLoc) {
          originAddress = [
            hqLoc.address,
            hqLoc.street,
            hqLoc.city,
            hqLoc.province ?? hqLoc.state,
            hqLoc.postal_code ?? hqLoc.postalCode,
          ].filter(Boolean).join(", ");
        }
      }
    }

    if (!originAddress) {
      console.warn(`Origin address is missing for delivery run ${runId}`);
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "Origin address is missing. Enter a start address or configure the HQ address.",
      });
    }

    // 4. Load stops from delivery ticket snapshots. Route estimation should
    // not require live location/profile lookups when snapshot addresses exist.
    const { data: ticketRows, error: ticketsError } = await supabase
      .from("delivery_tickets")
      .select("*")
      .eq("delivery_run_id", run.id)
      .order("stop_sequence", { ascending: true });

    if (ticketsError) {
      console.error("[Route Estimate Supabase Error]", ticketsError);
      return NextResponse.json({ error: ticketsError.message || "No stops assigned to this run." }, { status: 500 });
    }

    const stops = (ticketRows ?? [])
      .map((ticket: any) => ({
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        destinationName: ticket.destination_name ?? "",
        destinationAddress: ticket.destination_address ?? "",
        stopSequence: ticket.stop_sequence ?? null,
        status: ticket.status,
      }))
      .filter((t: any) => t.status !== "cancelled");

    console.log("[Route Estimate Request]", {
      runId,
      origin: originAddress,
      stopCount: stops.length,
      returnToStart,
      ticketAddresses: stops.map((t: any) => t.destinationAddress),
    });

    if (stops.length === 0) {
      return NextResponse.json({ routeEstimateAvailable: false, message: "No stops assigned to this run." }, { status: 400 });
    }

    const missingAddress = stops.some((t: any) => !t.destinationAddress?.trim());
    if (missingAddress) {
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "One or more stops missing destination address.",
      }, { status: 400 });
    }

    const activeStops = stops;

    // 5. Structure origin, destination, and intermediates for the Routes API
    const originWaypoint = { address: originAddress };
    let destinationWaypoint = null;
    let intermediatesWaypoints = [];

    if (returnToStart) {
      destinationWaypoint = { address: originAddress };
      intermediatesWaypoints = activeStops.map((t: any) => ({
        address: t.destinationAddress?.trim() || t.destinationName?.trim() || "",
      }));
    } else {
      // Last stop is the destination, prior stops are intermediates
      const lastStop = activeStops[activeStops.length - 1];
      destinationWaypoint = {
        address: lastStop.destinationAddress?.trim() || lastStop.destinationName?.trim() || "",
      };
      intermediatesWaypoints = activeStops.slice(0, -1).map((t: any) => ({
        address: t.destinationAddress?.trim() || t.destinationName?.trim() || "",
      }));
    }

    // 6. Assemble Google Routes API request payload
    const payload: any = {
      origin: originWaypoint,
      destination: destinationWaypoint,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    };

    if (intermediatesWaypoints.length > 0) {
      payload.intermediates = intermediatesWaypoints;
      if (optimize) {
        payload.optimizeWaypointOrder = true;
      }
    }

    // 7. Make API request to Google Maps Routes API (Directions v2:computeRoutes)
    const fieldMask = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex,routes.legs";
    const googleResponse = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!googleResponse.ok) {
      const errorText = await googleResponse.text();
      console.error("Google Routes API error response:", errorText);
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: `Google Routes API call failed: ${errorText || googleResponse.statusText}`,
      }, { status: googleResponse.status || 502 });
    }

    const resData = await googleResponse.json();
    if (!resData.routes || resData.routes.length === 0) {
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "No route found. Please check addresses.",
      });
    }

    const route = resData.routes[0];
    const distanceMeters = route.distanceMeters ?? 0;
    const durationStr = route.duration ?? "0s";
    const durationSeconds = parseInt(durationStr.replace("s", ""), 10) || 0;

    const estimatedDistanceKm = Number((distanceMeters / 1000).toFixed(2));
    const estimatedDurationMinutes = Math.round(durationSeconds / 60);
    const routePolyline = route.polyline?.encodedPolyline ?? null;

    // 8. Handle waypoint optimization reordering if optimize = true
    let finalOrderStops = [...activeStops];
    if (optimize && Array.isArray(route.optimizedIntermediateWaypointIndex)) {
      const optimizedIndices: number[] = route.optimizedIntermediateWaypointIndex;

      if (returnToStart) {
        // All active stops were intermediate waypoints
        const reordered = optimizedIndices.map((idx) => activeStops[idx]).filter(Boolean);
        const reorderedIds = new Set(reordered.map((t) => t.id));
        const remaining = activeStops.filter((t) => !reorderedIds.has(t.id));
        finalOrderStops = [...reordered, ...remaining];
      } else {
        // The last stop is the destination (excluded from intermediates)
        const intermediates = activeStops.slice(0, -1);
        const destinationStop = activeStops[activeStops.length - 1];
        const reorderedIntermediates = optimizedIndices
          .map((idx) => intermediates[idx])
          .filter(Boolean);
        const reorderedIds = new Set(reorderedIntermediates.map((t) => t.id));
        const remainingIntermediates = intermediates.filter((t) => !reorderedIds.has(t.id));
        finalOrderStops = [...reorderedIntermediates, ...remainingIntermediates, destinationStop];
      }

      // Sync the optimized order back to the database
      const orderedTicketIds = finalOrderStops.map((t) => t.id);
      await applyOptimizedStopOrder(run.id, orderedTicketIds);
    }

    // 9. Calculate stop-by-stop estimated arrival times and parse leg-by-leg details
    const parsedLegs = [];
    if (Array.isArray(route.legs) && route.legs.length > 0) {
      let currentTime = run.actualStartTime ? new Date(run.actualStartTime) : new Date();

      for (let i = 0; i < route.legs.length; i++) {
        const leg = route.legs[i];
        const legDistanceMeters = leg.distanceMeters ?? 0;
        const legDurationStr = leg.duration ?? "0s";
        const legDurationSeconds = parseInt(legDurationStr.replace("s", ""), 10) || 0;

        const distanceKm = Number((legDistanceMeters / 1000).toFixed(2));
        const durationMinutes = Math.round(legDurationSeconds / 60);

        // Accumulate driving duration
        currentTime = new Date(currentTime.getTime() + legDurationSeconds * 1000);

        let fromName = "";
        let fromAddress = "";
        if (i === 0) {
          fromName = run.startLocationName || "HQ / Central Kitchen";
          fromAddress = originAddress;
        } else {
          const prevStop = finalOrderStops[i - 1];
          if (prevStop) {
            fromName = prevStop.destinationName || "";
            fromAddress = prevStop.destinationAddress || prevStop.destinationName || "";
          }
        }

        let toName = "";
        let toAddress = "";
        let ticketId = null;
        let ticketNumber = null;

        const isLastReturnLeg = returnToStart && (i === route.legs.length - 1);

        if (isLastReturnLeg) {
          toName = run.startLocationName || "HQ / Central Kitchen";
          toAddress = originAddress;
        } else {
          const currentStop = finalOrderStops[i];
          if (currentStop) {
            toName = currentStop.destinationName || "";
            toAddress = currentStop.destinationAddress || currentStop.destinationName || "";
            ticketId = currentStop.id;
            ticketNumber = currentStop.ticketNumber;
          }
        }

        parsedLegs.push({
          sequence: i + 1,
          fromName,
          fromAddress,
          toName,
          toAddress,
          ticketId,
          ticketNumber,
          distanceKm,
          durationMinutes,
          estimatedArrivalTime: currentTime.toISOString(),
        });
      }
    }

    const ticketsWithETA = parsedLegs
      .filter((leg) => leg.ticketId !== null)
      .map((leg) => ({
        id: leg.ticketId!,
        estimatedArrivalTime: leg.estimatedArrivalTime,
      }));

    const googleRouteSummary = {
      source: "google",
      returnToStart: Boolean(returnToStart),
      estimatedDistanceKm,
      estimatedDurationMinutes,
      estimatedAt: new Date().toISOString(),
      origin: {
        name: run.startLocationName || "HQ / Central Kitchen",
        address: originAddress,
      },
      legs: parsedLegs,
    };

    // 10. Update the run route details and ticket ETAs in the database
    await updateDeliveryRunRouteEstimate(run.id, {
      estimatedDistanceKm,
      estimatedDurationMinutes,
      routeEstimateSource: "google",
      routePolyline,
      googleRouteSummary,
      tickets: ticketsWithETA,
    });

    return NextResponse.json({
      success: true,
      routeEstimateAvailable: true,
      estimatedDistanceKm,
      estimatedDurationMinutes,
      optimizedOrder: finalOrderStops.map((t) => t.id),
      googleRouteSummary,
    });
  } catch (err: any) {
    console.error("Backend compute route error:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
