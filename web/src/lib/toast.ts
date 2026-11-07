import { createKumoToastManager } from "@cloudflare/kumo";

export const toastManager = createKumoToastManager();

export const toast = {
  success: (title: string, description?: string) => toastManager.add({ title, description, variant: "success" }),
  error: (title: string, description?: string) =>
    toastManager.add({ title, description, variant: "error", timeout: 8000 }),
  info: (title: string, description?: string) => toastManager.add({ title, description, variant: "info" }),
};

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
