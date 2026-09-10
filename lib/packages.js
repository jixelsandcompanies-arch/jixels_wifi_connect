export const durationLabel = minutes => minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
export function assertPackage(input) {
  const price = Number(input.price_kes), duration = Number(input.duration_minutes);
  if (!input.name?.trim() || !input.slug?.trim()) throw new Error('Name and slug are required');
  if (!Number.isInteger(price) || price <= 0) throw new Error('Price must be a positive whole number');
  if (!Number.isInteger(duration) || duration <= 0) throw new Error('Duration must be a positive number of minutes');
  return { ...input, price_kes: price, duration_minutes: duration };
}
export function expiryFrom(packageRow, activatedAt = new Date()) { return new Date(activatedAt.getTime() + packageRow.duration_minutes * 60_000); }
