import { InputGroup, cn } from "@cloudflare/kumo";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <InputGroup className={cn("w-full max-w-xs", className)}>
      <InputGroup.Addon>
        <MagnifyingGlassIcon />
      </InputGroup.Addon>
      <InputGroup.Input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <InputGroup.Addon align="end">
          <InputGroup.Button shape="square" icon={XIcon} aria-label="clear" onClick={() => onChange("")} />
        </InputGroup.Addon>
      )}
    </InputGroup>
  );
}
