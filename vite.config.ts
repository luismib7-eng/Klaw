import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages publica el sitio en https://luismib7-eng.github.io/Klaw/
// La ruta distingue mayúsculas: debe coincidir exactamente con el nombre del repositorio.
export default defineConfig({
  plugins: [react()],
  base: "/Klaw/",
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000, // Remotion + React pesan ~550 kB sin comprimir; es esperado.
  },
});
