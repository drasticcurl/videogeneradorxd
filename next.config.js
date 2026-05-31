/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El pipeline corre dentro del proceso de Next (cola de jobs en memoria + filesystem).
  // Marcamos los modulos nativos/pesados como externos del server para evitar bundling raro.
  experimental: {
    serverComponentsExternalPackages: ["google-auth-library"],
  },
};

module.exports = nextConfig;
