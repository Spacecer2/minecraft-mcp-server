export function coerceCoordinates(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const coercedX = Number(x);
  const coercedY = Number(y);
  const coercedZ = Number(z);

  if (!Number.isFinite(coercedX) || !Number.isFinite(coercedY) || !Number.isFinite(coercedZ)) {
    throw new Error("x, y, and z must be valid numbers");
  }

  return { x: coercedX, y: coercedY, z: coercedZ };
}

export function validateWorldY(y: number, worldMinY = -64, worldMaxY = 320): void {
  if (y < worldMinY || y > worldMaxY) {
    throw new Error(`y coordinate ${y} is outside the valid world height range ${worldMinY}..${worldMaxY}`);
  }
}
