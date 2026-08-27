/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Build autocontenido: `.next/standalone/server.js` con solo las dependencias
  // que se usan de verdad. Es lo que arranca PM2 en la VPS, y es lo que permite
  // el patron de deploy releases/<timestamp> + symlink `current`: la release es
  // un directorio autosuficiente que se activa moviendo un symlink.
  // Sin esto no hay server.js y PM2 no tiene nada que levantar.
  output: "standalone",
  // El pipeline corre dentro del proceso de Next (cola de jobs en memoria + filesystem).
  // Marcamos los modulos nativos/pesados como externos del server para evitar bundling raro.
  experimental: {
    serverComponentsExternalPackages: ["google-auth-library"],
  },
};

module.exports = nextConfig;
