import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

export interface BrandConfig {
  company_name: string;
  tagline: string;
  logo_url: string;
  logo_dark_url: string | null;
  icon_url: string;
  favicon_url: string;
  primary_color: string;
  secondary_color: string;
  font_family: string;
  email_header_text: string;
  default_theme: string;
  allow_theme_override: number;
}

interface BrandingContextType {
  brand: BrandConfig | null;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextType>({ brand: null, refresh: async () => {} });

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [brand, setBrand] = useState<BrandConfig | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/branding");
      if (res.ok) {
        const data = await res.json();
        setBrand(data);
        if (data.favicon_url) {
          let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
          if (!link) {
            link = document.createElement("link");
            link.rel = "icon";
            document.head.appendChild(link);
          }
          link.href = data.favicon_url;
        }
        if (data.company_name) {
          document.title = `${data.company_name} | ${data.tagline || "HPP Reporting Portal"}`;
        }
      }
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return <BrandingContext.Provider value={{ brand, refresh }}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextType {
  return useContext(BrandingContext);
}
