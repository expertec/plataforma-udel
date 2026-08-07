export const FACE_DESCRIPTOR_LENGTH = 128;
export const FACE_MATCH_DISTANCE_THRESHOLD = 0.62;

export function normalizeFaceDescriptor(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length !== FACE_DESCRIPTOR_LENGTH) return null;
  const descriptor = value.map((item) =>
    typeof item === "number" && Number.isFinite(item) ? item : Number.NaN,
  );
  return descriptor.every(Number.isFinite) ? descriptor : null;
}

export function calculateFaceDescriptorDistance(left: number[], right: number[]): number {
  if (left.length !== FACE_DESCRIPTOR_LENGTH || right.length !== FACE_DESCRIPTOR_LENGTH) {
    return Number.POSITIVE_INFINITY;
  }

  let sum = 0;
  for (let index = 0; index < FACE_DESCRIPTOR_LENGTH; index += 1) {
    const diff = left[index] - right[index];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function distanceToConfidence(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  const confidence = 1 - distance;
  return Math.max(0, Math.min(1, confidence));
}
