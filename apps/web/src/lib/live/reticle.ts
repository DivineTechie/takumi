/**
 * Reticle coordinate mapping and canvas rendering for TAKUMI Live Coach.
 * Maps Gemini [y, x] points (0-1000) through object-fit: cover crop to screen pixels.
 */

export interface VideoCropDimensions {
  videoWidth: number;
  videoHeight: number;
  screenWidth: number;
  screenHeight: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface ReticlePoint {
  point: [number, number]; // [y, x] normalized in 0-1000
  label: string;
}

/**
 * Maps normalized [0, 1000] point [y, x] to screen coordinates
 * accounting for object-fit: cover cropping and scaling.
 * 
 * Because sent frames are mirrored if and only if the preview is mirrored,
 * the x coordinate in the sent frame directly corresponds to the visual x coordinate.
 */
export function mapNormalizedPointToScreen(
  point: [number, number],
  dims: VideoCropDimensions
): ScreenPoint {
  const { videoWidth, videoHeight, screenWidth, screenHeight } = dims;
  if (!videoWidth || !videoHeight || !screenWidth || !screenHeight) {
    return { x: 0, y: 0, visible: false };
  }

  const [normY, normX] = point;
  const scale = Math.max(screenWidth / videoWidth, screenHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;

  const offsetX = (screenWidth - renderedWidth) / 2;
  const offsetY = (screenHeight - renderedHeight) / 2;

  const screenX = offsetX + (normX / 1000) * renderedWidth;
  const screenY = offsetY + (normY / 1000) * renderedHeight;

  const visible =
    screenX >= 0 && screenX <= screenWidth && screenY >= 0 && screenY <= screenHeight;

  return { x: screenX, y: screenY, visible };
}

/**
 * Draws animated pulsing yellow rings with adjacent labels on an overlay canvas.
 */
export function renderReticles(
  ctx: CanvasRenderingContext2D,
  reticles: ReticlePoint[],
  dims: VideoCropDimensions,
  timestampMs: number
): void {
  ctx.clearRect(0, 0, dims.screenWidth, dims.screenHeight);

  if (!reticles || reticles.length === 0) {
    return;
  }

  // Animation pulse: oscillates between 0 and 1 every ~1200ms
  const phase = (timestampMs % 1200) / 1200;
  const pulseRadius = 24 + Math.sin(phase * Math.PI * 2) * 6; // 18px to 30px
  const ringAlpha = 0.8 + Math.sin(phase * Math.PI * 2) * 0.2; // 0.6 to 1.0

  ctx.save();

  for (const item of reticles) {
    const screenPt = mapNormalizedPointToScreen(item.point, dims);
    if (!screenPt.visible) {
      continue;
    }

    const { x, y } = screenPt;

    // 1. Outer animated glowing halo
    ctx.beginPath();
    ctx.arc(x, y, pulseRadius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(250, 204, 21, ${ringAlpha * 0.35})`;
    ctx.lineWidth = 6;
    ctx.stroke();

    // 2. Crisp main yellow ring
    ctx.beginPath();
    ctx.arc(x, y, pulseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = '#facc15'; // yellow-400
    ctx.lineWidth = 3.5;
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 8;
    ctx.stroke();

    // 3. Center targeting crosshair dot
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 4;
    ctx.fill();

    // 4. Pointer label sitting right next to the ring
    if (item.label) {
      const text = item.label;
      ctx.font = 'bold 13px "Noto Sans", sans-serif';
      const textMetrics = ctx.measureText(text);
      const paddingX = 8;
      const badgeWidth = textMetrics.width + paddingX * 2;
      const badgeHeight = 24;

      // Position to the right of the ring, with fallback to left if too close to screen edge
      let badgeX = x + pulseRadius + 10;
      if (badgeX + badgeWidth > dims.screenWidth - 10) {
        badgeX = x - pulseRadius - 10 - badgeWidth;
      }
      const badgeY = y - badgeHeight / 2;

      // Draw pill background
      ctx.fillStyle = 'rgba(15, 20, 27, 0.9)'; // industrial dark surface
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 6);
      ctx.fill();
      ctx.stroke();

      // Draw label text
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 0;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, badgeX + paddingX, badgeY + badgeHeight / 2);
    }
  }

  ctx.restore();
}
