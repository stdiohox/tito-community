import { ImageResponse } from "next/og";

/**
 * The app mark, drawn as an image at request time so the repo carries no
 * binary icon files: a gold ring with a serif "T" on Forest. `inset` shrinks
 * the mark for maskable icons, which platforms crop to a circle.
 */
export function brandIcon(size: number, inset = 0.18) {
  const ring = Math.round(size * (1 - inset * 2));
  const stroke = Math.max(2, Math.round(size * 0.022));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1A3A16",
        }}
      >
        <div
          style={{
            width: ring,
            height: ring,
            borderRadius: "50%",
            border: `${stroke}px solid #C9A84C`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#F8F5EE",
            fontSize: Math.round(ring * 0.58),
            fontFamily: "Georgia, serif",
            lineHeight: 1,
            paddingBottom: Math.round(ring * 0.04),
          }}
        >
          T
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
