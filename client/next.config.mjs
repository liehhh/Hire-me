// Cross-origin isolation enables SharedArrayBuffer, which lets ONNX Runtime
// run the in-browser Whisper fallback (WASM) multithreaded instead of on a
// single core. "credentialless" keeps CORS-enabled
// cross-origin fetches (e.g. the Hugging Face model download) working.
const crossOriginIsolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev double-mounting would start the avatar/TTS/mic pipeline twice.
  reactStrictMode: false,
  // Amplify serves a static export (the app has no server-side routes); the
  // isolation headers are then set in amplify.yml. Locally, dev keeps headers().
  ...(process.env.STATIC_EXPORT === "1"
    ? { output: "export" }
    : {
        async headers() {
          return [{ source: "/:path*", headers: crossOriginIsolation }];
        },
      }),
  // Everything heavy (transformers.js, TalkingHead) runs in the
  // browser only; stub the Node-specific halves of transformers.js.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    // transformers.js reads import.meta.url directly; webpack can't analyse it
    // but the runtime behaviour is correct, so silence the warning.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /@huggingface[\\/]transformers[\\/]dist/, message: /import\.meta/ },
    ];
    return config;
  },
};

export default nextConfig;
