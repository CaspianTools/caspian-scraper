"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { COUNTRIES, COUNTRY_ALIASES, COUNTRY_GROUPS } from "@/lib/countries";

interface Props {
  value: string[];
  onChange: (countries: string[]) => void;
  placeholder?: string;
}

type Option =
  | { kind: "group"; label: string; countries: readonly string[] }
  | { kind: "country"; label: string }
  | { kind: "custom"; label: string };

const fold = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Searchable multi-select for countries: type to filter (aliases like "UAE"
 * or "KSA" work), pick with click / Enter / arrow keys, remove with × or
 * Backspace. Region groups add all their countries at once. A value that isn't
 * in the list can still be added ("Remote", "Regional", …).
 */
export function CountrySelect({ value, onChange, placeholder = "Search countries…" }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const chosen = useMemo(() => new Set(value.map(fold)), [value]);

  const options = useMemo<Option[]>(() => {
    const q = fold(query.trim());
    const out: Option[] = [];
    for (const g of COUNTRY_GROUPS) {
      if (g.countries.every((c) => chosen.has(fold(c)))) continue;
      if (!q || fold(g.label).includes(q)) out.push({ kind: "group", ...g });
    }
    const starts: Option[] = [];
    const contains: Option[] = [];
    for (const c of COUNTRIES) {
      if (chosen.has(fold(c))) continue;
      const names = [fold(c), ...(COUNTRY_ALIASES[c] ?? [])];
      if (!q || names.some((n) => n.startsWith(q))) starts.push({ kind: "country", label: c });
      else if (names.some((n) => n.includes(q))) contains.push({ kind: "country", label: c });
    }
    out.push(...starts, ...contains);
    const exact = COUNTRIES.some((c) => fold(c) === q) || chosen.has(q);
    if (q && !exact) out.push({ kind: "custom", label: query.trim() });
    return out;
  }, [query, chosen]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function add(names: readonly string[]) {
    const next = [...value];
    for (const n of names) if (!next.some((v) => fold(v) === fold(n))) next.push(n);
    onChange(next);
  }

  function pick(o: Option | undefined) {
    if (!o) return;
    add(o.kind === "group" ? o.countries : [o.label]);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }

  function remove(name: string) {
    onChange(value.filter((v) => v !== name));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      // Never submit a surrounding form (or trigger a parent's Enter-to-save)
      // from inside the picker.
      e.preventDefault();
      e.stopPropagation();
      if (open) pick(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
        className="min-h-10 w-full px-2 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm flex flex-wrap items-center gap-1.5 cursor-text focus-within:ring-2 focus-within:ring-zinc-400"
      >
        {value.map((c) => (
          <span
            key={c}
            className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-xs"
          >
            {c}
            <button
              type="button"
              aria-label={`Remove ${c}`}
              onClick={() => remove(c)}
              className="w-4 h-4 inline-flex items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-24 h-6 px-1 bg-transparent outline-none"
        />
      </div>

      {open && options.length > 0 && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-40 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg py-1 text-sm"
        >
          {options.map((o, i) => (
            <li
              key={`${o.kind}:${o.label}`}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={
                "px-3 py-1.5 cursor-pointer flex items-center justify-between gap-3 " +
                (i === active ? "bg-zinc-100 dark:bg-zinc-800" : "")
              }
            >
              {o.kind === "group" ? (
                <>
                  <span className="font-medium">{o.label}</span>
                  <span className="text-xs text-zinc-500">adds {o.countries.length} countries</span>
                </>
              ) : o.kind === "custom" ? (
                <span>
                  Add <span className="font-medium">“{o.label}”</span>
                </span>
              ) : (
                <span>{o.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
