import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tito Circle",
    short_name: "Tito Circle",
    description: "Tito Finance's private members' circle.",
    start_url: "/picks",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#1A3A16",
    theme_color: "#1A3A16",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
