import { useMemo, useState, type ReactNode } from "react";
import { Button, ChartPalette, LayerCard, Meter, Table, TimeseriesChart } from "@cloudflare/kumo";
import { BroomIcon } from "@phosphor-icons/react";
import { api, type StatsDay } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { echarts } from "@/lib/echarts";
import { displayName, formatBytes, formatDay, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Page } from "@/components/Page";
import { MfaBanner } from "@/components/MfaBanner";

const dayTs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export default function DashboardPage() {
  const { t, lang, errMsg } = useI18n();
  const { isDark } = useTheme();
  const stats = useAsync(() => api.admin.stats(30), []);
  const [gcRunning, setGcRunning] = useState(false);

  const series = useMemo(() => {
    const s: StatsDay[] = stats.data?.series ?? [];
    const pts = (f: (d: StatsDay) => number) => s.map((d) => [dayTs(d.day), f(d)] as [number, number]);
    return {
      requests: [{ name: t("dash.requests"), data: pts((d) => d.requests), color: ChartPalette.categorical(0, isDark) }],
      traffic: [
        { name: t("dash.upload"), data: pts((d) => d.upload_bytes), color: ChartPalette.categorical(1, isDark) },
        { name: t("dash.download"), data: pts((d) => d.download_bytes), color: ChartPalette.categorical(0, isDark) },
      ],
      transfers: [
        { name: t("dash.uploads"), data: pts((d) => d.uploads), color: ChartPalette.categorical(1, isDark) },
        { name: t("dash.downloads"), data: pts((d) => d.downloads), color: ChartPalette.categorical(0, isDark) },
      ],
    };
  }, [stats.data, isDark, t]);

  const runGc = async () => {
    setGcRunning(true);
    try {
      const r = await api.admin.gc();
      const summary = Object.entries(r.result)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ");
      toast.success(t("dash.gcDone"), summary);
      stats.reload();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setGcRunning(false);
    }
  };

  const d = stats.data;
  const sum = (f: (d: StatsDay) => number) => (d?.series ?? []).reduce((a, x) => a + f(x), 0);
  const tickDay = (ts: number) => formatDay(ts, lang);

  return (
    <Page
      title={t("dash.title")}
      description={t("dash.subtitle")}
      actions={
        <Button icon={BroomIcon} loading={gcRunning} onClick={runGc}>
          {t("dash.runGc")}
        </Button>
      }
    >
      <MfaBanner />
      {stats.error != null && <ErrorState error={stats.error} onRetry={stats.reload} />}
      {!d ? (
        stats.loading && <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Tile label={t("dash.users")} value={formatNumber(d.totals.users, lang)} />
            <Tile label={t("dash.projects")} value={formatNumber(d.totals.projects, lang)} />
            <Tile label={t("dash.files")} value={formatNumber(d.totals.blobs, lang)} />
            <Tile label={t("dash.storage")} value={formatBytes(d.totals.used_bytes)} />
            <Tile label={t("dash.shares")} value={formatNumber(d.totals.shares, lang)} />
            <Tile label={t("dash.backends")} value={formatNumber(d.totals.storages, lang)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title={t("dash.requests")} hint={`${t("dash.last30")} · ${formatNumber(sum((x) => x.requests), lang)}`}>
              <TimeseriesChart
                echarts={echarts}
                isDarkMode={isDark}
                data={series.requests}
                height={260}
                gradient
                yAxisMinInterval={1}
                xAxisTickFormat={tickDay}
                tooltipTimestampFormat={tickDay}
                tooltipValueFormat={(v) => formatNumber(v, lang)}
              />
            </ChartCard>
            <ChartCard
              title={t("dash.traffic")}
              hint={`↑ ${formatBytes(sum((x) => x.upload_bytes))} · ↓ ${formatBytes(sum((x) => x.download_bytes))}`}
            >
              <TimeseriesChart
                echarts={echarts}
                isDarkMode={isDark}
                type="bar"
                data={series.traffic}
                height={260}
                xAxisTickFormat={tickDay}
                tooltipTimestampFormat={tickDay}
                yAxisTickFormat={(v) => formatBytes(v, 0)}
                tooltipValueFormat={(v) => formatBytes(v)}
              />
            </ChartCard>
          </div>

          <ChartCard
            title={`${t("dash.uploads")} / ${t("dash.downloads")}`}
            hint={`↑ ${formatNumber(sum((x) => x.uploads), lang)} · ↓ ${formatNumber(sum((x) => x.downloads), lang)}`}
          >
            <TimeseriesChart
              echarts={echarts}
              isDarkMode={isDark}
              data={series.transfers}
              height={220}
              yAxisMinInterval={1}
              xAxisTickFormat={tickDay}
              tooltipTimestampFormat={tickDay}
            />
          </ChartCard>

          <div className="grid gap-4 xl:grid-cols-2">
            <LayerCard className="p-0">
              <LayerCard.Secondary className="px-5 py-3 font-medium">{t("dash.topUsers")}</LayerCard.Secondary>
              <LayerCard.Primary className="p-0">
                <Table>
                  <Table.Body>
                    {d.top_users.length === 0 && (
                      <Table.Row>
                        <Table.Cell className="py-8 text-center text-kumo-subtle">{t("dash.noData")}</Table.Cell>
                      </Table.Row>
                    )}
                    {d.top_users.map((u) => (
                      <Table.Row key={u.id}>
                        <Table.Cell className="w-1/3 font-medium">{displayName(u)}</Table.Cell>
                        <Table.Cell>
                          <Meter
                            label={formatBytes(u.used_bytes)}
                            value={u.quota_bytes > 0 ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0}
                            customValue={u.quota_bytes < 0 ? t("common.unlimited") : formatBytes(u.quota_bytes)}
                          />
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </LayerCard.Primary>
            </LayerCard>
            <LayerCard className="p-0">
              <LayerCard.Secondary className="px-5 py-3 font-medium">{t("dash.perStorage")}</LayerCard.Secondary>
              <LayerCard.Primary className="p-0">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>{t("common.name")}</Table.Head>
                      <Table.Head className="text-right">{t("dash.files")}</Table.Head>
                      <Table.Head className="text-right">{t("storages.used")}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {d.storages.map((s) => (
                      <Table.Row key={s.id}>
                        <Table.Cell className="font-medium">{s.name}</Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{formatNumber(s.blob_count, lang)}</Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{formatBytes(s.used_bytes)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </LayerCard.Primary>
            </LayerCard>
          </div>

          <LayerCard className="p-0">
            <LayerCard.Secondary className="flex items-center justify-between px-5 py-3">
              <span className="font-medium">{t("dash.topTraffic")}</span>
              <span className="text-xs text-kumo-subtle">{t("dash.last30")}</span>
            </LayerCard.Secondary>
            <LayerCard.Primary className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>{t("nav.users")}</Table.Head>
                      <Table.Head className="text-right">{t("dash.requests")}</Table.Head>
                      <Table.Head className="text-right">{t("dash.upload")}</Table.Head>
                      <Table.Head className="text-right">{t("dash.download")}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {(d.top_traffic ?? []).length === 0 && (
                      <Table.Row>
                        <Table.Cell colSpan={4} className="py-8 text-center text-kumo-subtle">
                          {t("dash.noData")}
                        </Table.Cell>
                      </Table.Row>
                    )}
                    {(d.top_traffic ?? []).map((u) => (
                      <Table.Row key={u.id || "anon"}>
                        <Table.Cell className="font-medium">
                          {u.username ? displayName({ username: u.username, display_name: u.display_name }) : (
                            <span className="text-kumo-subtle">{t("dash.anonymous")}</span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{formatNumber(u.requests, lang)}</Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{formatBytes(u.upload_bytes)}</Table.Cell>
                        <Table.Cell className="text-right tabular-nums">{formatBytes(u.download_bytes)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </LayerCard.Primary>
          </LayerCard>
        </>
      )}
    </Page>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard>
      <LayerCard.Primary className="flex flex-col gap-1.5">
        <span className="text-sm text-kumo-subtle">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <LayerCard className="p-0">
      <LayerCard.Secondary className="flex items-center justify-between gap-2 px-5 py-3">
        <span className="font-medium">{title}</span>
        {hint && <span className="text-xs text-kumo-subtle">{hint}</span>}
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-3 py-2">{children}</LayerCard.Primary>
    </LayerCard>
  );
}
