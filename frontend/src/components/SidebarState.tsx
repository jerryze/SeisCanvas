import { createContext, useContext, useState, type ReactNode } from "react";

type SidebarValue = string | boolean;
type SidebarState = {
  scope: string;
  values: Record<string, SidebarValue>;
  setValue: (key: string, value: SidebarValue) => void;
};
const SidebarContext = createContext<SidebarState | null>(null);

/** UI-only state stays separate from scientific display and export settings. */
export function SidebarStateProvider({
  scope,
  children,
  values: controlled,
  onChange,
}: {
  scope: string;
  children: ReactNode;
  values?: Record<string, SidebarValue>;
  onChange?: (update: (previous: Record<string, SidebarValue>) => Record<string, SidebarValue>) => void;
}) {
  const [values, setValues] = useState<Record<string, SidebarValue>>({});
  return (
    <SidebarContext.Provider
      value={{
        scope,
        values: controlled ?? values,
        setValue: (key, value) =>
          (onChange ?? setValues)((previous) =>
            previous[key] === value ? previous : { ...previous, [key]: value },
          ),
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebarValue<T extends SidebarValue>(
  id: string,
  fallback: T,
): [T, (value: T) => void] {
  const context = useContext(SidebarContext);
  const [local, setLocal] = useState<T | undefined>(undefined);
  const key = `${context?.scope}:${id}`;
  return [
    ((context ? context.values[key] : local) ?? fallback) as T,
    (value) => (context ? context.setValue(key, value) : setLocal(value)),
  ];
}
