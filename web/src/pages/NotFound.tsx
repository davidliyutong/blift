import { Button, Empty } from "@cloudflare/kumo";
import { CompassIcon } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useT } from "@/i18n";
import { Page } from "@/components/Page";

export function NotFoundPage() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Page title="404">
      <Empty
        icon={<CompassIcon size={48} weight="duotone" />}
        title={t("err.not_found")}
        contents={
          <Button variant="primary" onClick={() => navigate("/projects")}>
            {t("nav.projects")}
          </Button>
        }
      />
    </Page>
  );
}
