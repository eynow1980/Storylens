// src/manifest.ts
import { defineManifest } from "@plasmo/plugin"

export default defineManifest({
  manifest_version: 3,
  name: "StoryLens",
  version: "0.1.0",
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwU8W2m7LQSeP/8MRg1AY4jSyN213i7qyggTGvdRkztY4n8UDj7PRxi9ORnYLcef2b54Yd/euGVnWPR9QjMx4QNhmvcFjEdyPWI9Xo3caitvlhpvWHWPfw4S33/uGbU4oKJQQAGFRMZNq8odm88Lg+To+AXLz3z4dKiUDi/cCa7AoyG2gifEswIMYrPGPL3zI7Ji13tybcgVLZV7P10BoYAUE5cG1UZYFc488BZTMUF8SoUQxnHg/K1yBLW7KZXDXuIni/8tQFrlDUHlMKC6bHUWIcR8oIe7ROxCBxFr5sCVDb5TU9oVCtLk6+TEBF81UTUYNsLXf6pG0S9sAcSWa4wIDAQAB",               // keep the key you generated
  permissions: ["identity", "storage", "activeTab", "scripting"],
  host_permissions: [
    "https://docs.google.com/*",
    "https://www.googleapis.com/*",
    "https://docs.googleapis.com/*"
  ],
  oauth2: {
    client_id: "1080423724315-mujeaeq5p6t0a2uptok447lbbmcm37pl.apps.googleusercontent.com",
    scopes: [
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/drive.readonly"
    ]
  },
  background: { service_worker: "background.ts" },
  action: { default_title: "StoryLens" }
})

