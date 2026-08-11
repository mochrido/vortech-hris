const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two coordinates, in meters. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const radLat1 = toRadians(lat1);
  const radLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  radius_m: number | null;
}

/** True when the point is within the radius of at least one location (on-radius counts as inside). */
export function isInsideGeofence(lat: number, lon: number, locations: GeoLocation[]): boolean {
  return locations.some(
    (location) =>
      location.radius_m != null && haversineMeters(lat, lon, location.latitude, location.longitude) <= location.radius_m,
  );
}
