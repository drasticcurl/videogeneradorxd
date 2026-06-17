/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Build autocontenido para contenedor (Cloud Run): copia solo lo necesario a
  // .next/standalone. Ver Dockerfile.
  output: "standalone",
  // El pipeline corre dentro del proceso de Next (cola de jobs en memoria + filesystem).
  // Marcamos los modulos nativos/pesados como externos del server para evitar bundling raro.
  experimental: {
    serverComponentsExternalPackages: ["google-auth-library", "archiver"],
  },
};

module.exports = nextConfig;
