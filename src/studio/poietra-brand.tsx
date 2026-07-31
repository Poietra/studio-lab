import poietraSymbolUrl from "../assets/poietra-symbol-05b.svg";
import { cn } from "../lib/cn";

type PoietraBrandProps = Readonly<{
  className?: string;
  nameClassName?: string;
}>;

export function PoietraBrand({ className, nameClassName }: PoietraBrandProps) {
  return (
    <h1 aria-label="Poietra Studio Lab" className={cn("flex shrink-0 items-center gap-2", className)}>
      <img
        alt=""
        aria-hidden="true"
        className="size-6 shrink-0 brightness-0 invert"
        data-poietra-symbol
        draggable={false}
        src={poietraSymbolUrl}
      />
      <span aria-hidden="true" className={cn("text-balance text-sm font-semibold", nameClassName)}>
        Poietra Studio Lab
      </span>
    </h1>
  );
}
