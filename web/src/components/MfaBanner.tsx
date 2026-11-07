import { Banner, Button } from "@cloudflare/kumo";
import { ShieldWarningIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useT } from "@/i18n";
import { useUser } from "@/lib/session";

/** Shown on admin pages while the admin has no TOTP configured. */
export function MfaBanner() {
  const t = useT();
  const user = useUser();
  const navigate = useNavigate();
  if (user.role !== "admin" || user.totp_enabled) return null;
  return (
    <Banner
      variant="alert"
      icon={<ShieldWarningIcon weight="fill" />}
      title={t("admin.mfaBannerTitle")}
      description={t("admin.mfaBannerDesc")}
      action={
        <Button size="sm" variant="secondary" onClick={() => navigate("/settings#security")}>
          {t("admin.mfaBannerAction")}
        </Button>
      }
    />
  );
}
