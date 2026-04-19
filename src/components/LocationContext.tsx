"use client";

/**
 * LocationContext — global active-location state for HQ admins.
 *
 * Why this exists:
 *   HQ admins can see all locations. When they create inventory items they must
 *   explicitly choose WHICH location the item belongs to. Before this context,
 *   resolveLocationId() always returned "LOC-HQ" for every HQ admin — meaning
 *   every item they created was silently stamped LOC-HQ even when they intended
 *   a different location.
 *
 * Behaviour:
 *   • activeLocation = null            → "All Locations (HQ View)" — read-only mode
 *   • activeLocation = { id, name }    → a specific location is selected
 *
 * Non-HQ users never use this context; their location comes from user.locationId.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

export type LocationOption = {
  id:   string;  // matches locations.id in the DB  (e.g. "LOC-HQ", "LOC-001")
  name: string;  // human-readable label             (e.g. "HQ Kitchen", "Downtown")
};

type LocationContextValue = {
  /** The currently selected location, or null = "All Locations" read-only mode */
  activeLocation: LocationOption | null;
  /** Call this from the Header dropdown when the admin picks a location */
  setActiveLocation: (loc: LocationOption | null) => void;
};

const LocationContext = createContext<LocationContextValue>({
  activeLocation:    null,
  setActiveLocation: () => {},
});

export function LocationProvider({ children }: { children: ReactNode }) {
  const [activeLocation, setActiveLocationState] = useState<LocationOption | null>(null);

  const setActiveLocation = useCallback((loc: LocationOption | null) => {
    console.log("[LocationContext] active location changed →", loc);
    setActiveLocationState(loc);
  }, []);

  return (
    <LocationContext.Provider value={{ activeLocation, setActiveLocation }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useActiveLocation() {
  return useContext(LocationContext);
}
