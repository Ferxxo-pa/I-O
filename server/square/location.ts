import { squareFetch } from "./client";

let locationId: string | null = null;

export async function squareLocationId(): Promise<string | null> {
  if (locationId) return locationId;
  if (process.env.SQUARE_LOCATION_ID) {
    locationId = process.env.SQUARE_LOCATION_ID;
    return locationId;
  }

  const body = await squareFetch<{
    locations?: Array<{ id?: string; status?: string }>;
  }>("/v2/locations");
  const locations = body.locations ?? [];
  const active = locations.find((location) => location.status === "ACTIVE" && location.id);
  locationId = active?.id ?? locations.find((location) => location.id)?.id ?? null;
  return locationId;
}
