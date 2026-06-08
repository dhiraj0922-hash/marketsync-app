import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  getDeliveryRunById,
  updateDeliveryRunRouteEstimate,
  applyOptimizedStopOrder,
} from "@/lib/storage";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { runId, optimize, returnToStart } = body;

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

    // 2. Load delivery run
    const runRes = await getDeliveryRunById(runId);
    if (!runRes.success || !runRes.data) {
      return NextResponse.json({ error: runRes.error?.message || "Delivery run not found" }, { status: 404 });
    }
    const run = runRes.data;

    // 3. Determine origin address
    let originAddress = run.startAddress?.trim();
    if (!originAddress) {
      // Fetch LOC-HQ location to get address details
      const { data: hqLoc } = await supabase
        .from("locations")
        .select("*")
        .eq("id", "LOC-HQ")
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

    if (!originAddress) {
      console.warn(`Origin address is missing for delivery run ${runId}`);
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "Origin address is missing. Enter a start address or configure the HQ address.",
      });
    }

    // 4. Load stops (delivery tickets) sorted by sequence
    const stops = [...(run.tickets || [])]
      .sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999))
      .filter((t: any) => t.status !== "cancelled");

    // If there are no stops, we return a zero route estimate
    if (stops.length === 0) {
      await updateDeliveryRunRouteEstimate(runId, {
        estimatedDistanceKm: 0,
        estimatedDurationMinutes: 0,
        routeEstimateSource: "google",
        routePolyline: null,
        googleRouteSummary: null,
        tickets: [],
      });
      return NextResponse.json({
        success: true,
        routeEstimateAvailable: true,
        estimatedDistanceKm: 0,
        estimatedDurationMinutes: 0,
        optimizedOrder: [],
      });
    }

    // Filter stops to ensure they have an address or name
    const activeStops = stops.filter(
      (t: any) => (t.destinationAddress?.trim() || t.destinationName?.trim() || "") !== ""
    );

    if (activeStops.length === 0) {
      return NextResponse.json({
        routeEstimateAvailable: false,
        message: "Stops are missing destination addresses. Enter addresses manually.",
      });
    }

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
        message: `Google Routes API call failed. Fallback to manual estimation.`,
      });
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
      await applyOptimizedStopOrder(runId, orderedTicketIds);
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
    await updateDeliveryRunRouteEstimate(runId, {
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
