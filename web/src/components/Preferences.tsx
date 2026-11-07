import { Button, DropdownMenu } from "@cloudflare/kumo";
import { DesktopIcon, MoonIcon, SunIcon, TranslateIcon } from "@phosphor-icons/react";
import { useI18n, type Lang } from "@/i18n";
import { useTheme, type ThemePref } from "@/lib/theme";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
];

export function LanguageMenu() {
  const { lang, setLang, t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" shape="square" icon={TranslateIcon} aria-label={t("nav.language")} />}
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={lang} onValueChange={(v) => setLang(v as Lang)}>
          {LANGS.map((l) => (
            <DropdownMenu.RadioItem key={l.value} value={l.value} closeOnClick>
              {l.label}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function ThemeMenu() {
  const { t } = useI18n();
  const { pref, setPref, isDark } = useTheme();
  const items: { value: ThemePref; label: string; icon: typeof SunIcon }[] = [
    { value: "light", label: t("nav.theme.light"), icon: SunIcon },
    { value: "dark", label: t("nav.theme.dark"), icon: MoonIcon },
    { value: "system", label: t("nav.theme.system"), icon: DesktopIcon },
  ];
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button variant="ghost" shape="square" icon={isDark ? MoonIcon : SunIcon} aria-label={t("nav.theme")} />
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          {items.map((it) => (
            <DropdownMenu.RadioItem key={it.value} value={it.value} icon={it.icon} closeOnClick>
              {it.label}
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
