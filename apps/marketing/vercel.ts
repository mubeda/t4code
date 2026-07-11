import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t4code/marketing'",
  buildCommand: "vp run --filter @t4code/marketing build",
  outputDirectory: "dist",
};
