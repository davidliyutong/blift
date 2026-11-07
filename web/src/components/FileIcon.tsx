import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon as GenericIcon,
  FileImageIcon,
  FilePdfIcon,
  FileTextIcon,
  FileVideoIcon,
} from "@phosphor-icons/react";

const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst|iso|dmg)$/i;
const CODE = /\.(js|ts|tsx|go|py|rs|java|c|cpp|h|sh|json|yaml|yml|toml|html|css|sql)$/i;

export function FileIcon({ name, type, size = 18 }: { name: string; type: string; size?: number }) {
  const props = { size, weight: "duotone" as const, className: "shrink-0 text-kumo-subtle" };
  if (type.startsWith("image/")) return <FileImageIcon {...props} />;
  if (type.startsWith("video/")) return <FileVideoIcon {...props} />;
  if (type.startsWith("audio/")) return <FileAudioIcon {...props} />;
  if (type === "application/pdf") return <FilePdfIcon {...props} />;
  if (ARCHIVE.test(name) || type.includes("zip") || type.includes("compressed")) return <FileArchiveIcon {...props} />;
  if (CODE.test(name)) return <FileCodeIcon {...props} />;
  if (type.startsWith("text/")) return <FileTextIcon {...props} />;
  return <GenericIcon {...props} />;
}
