import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { useBranding } from "../contexts/BrandingContext";
import {
  LayoutDashboard,
  FileText,
  PenSquare,
  Users,
  Shield,
  Send,
  Mail,
  HardDrive,
  Palette,
  KeyRound,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  Lock,
  ChevronDown,
} from "lucide-react";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { user, logout, isSuperAdmin, isAdmin, isManager, isViewOnly, canManageUsers } = useAuth();
  const { theme, setTheme } = useTheme();
  const { brand } = useBranding();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  const companyName = brand?.company_name || "Welfare Pride";
  const iconUrl = brand?.icon_url || "/assets/branding/welfare-pride-icon.png";

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, visible: true },
    { href: "/reports", label: "Reports", icon: FileText, visible: true },
    { href: "/metrics", label: "Metric Entry", icon: PenSquare, visible: isSuperAdmin || isAdmin || isManager },
    { href: "/users", label: "User Access", icon: Users, visible: canManageUsers },
    { href: "/audit", label: "Audit Center", icon: Shield, visible: isSuperAdmin || isAdmin },
    { href: "/siem", label: "SIEM & Syslog", icon: Send, visible: isSuperAdmin },
    { href: "/email", label: "Email Engine", icon: Mail, visible: isSuperAdmin },
    { href: "/backups", label: "Backups", icon: HardDrive, visible: isSuperAdmin || isAdmin },
    { href: "/branding", label: "Branding", icon: Palette, visible: isSuperAdmin },
    { href: "/security", label: "Security & SSO", icon: KeyRound, visible: isSuperAdmin },
  ].filter(i => i.visible);

  const roleLabel: Record<string, string> = {
    super_admin: "Super Admin",
    admin: "Admin",
    manager: "Manager",
    view_only: "View Only",
  };

  const roleColor: Record<string, string> = {
    super_admin: "bg-purple-500/15 text-purple-600 dark:text-purple-300 border-purple-500/30",
    admin: "bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30",
    manager: "bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30",
    view_only: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <a href="#maincontent" className="skip-link">Skip to main content</a>

      {/* Top header */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/75 no-print">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center justify-between gap-3 h-16">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-3 min-w-0 focus-ring rounded-lg">
            <img src={iconUrl} alt="" className="h-9 w-9 rounded-full object-cover shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            <div className="min-w-0">
              <span className="font-bold text-base sm:text-lg tracking-tight truncate block">{companyName}</span>
              <span className="text-[11px] text-muted-foreground hidden sm:block truncate">{brand?.tagline || "HPP Reporting Portal"}</span>
            </div>
          </Link>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            {/* Theme switcher */}
            <div className="relative">
              <button
                onClick={() => setThemeOpen(!themeOpen)}
                className="touch-target inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-xl border border-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground focus-ring"
                aria-label="Theme selector"
                aria-expanded={themeOpen}
              >
                {theme === "light" && <Sun size={15} />}
                {theme === "dark" && <Moon size={15} />}
                {theme === "system" && <Monitor size={15} />}
                <span className="hidden sm:inline capitalize">{theme}</span>
                <ChevronDown size={13} />
              </button>
              {themeOpen && (
                <div className="absolute right-0 mt-1 w-36 rounded-xl border border-border bg-card p-1 shadow-xl z-50 text-xs">
                  {(["light", "dark", "system"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => { setTheme(t); setThemeOpen(false); }}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left capitalize ${theme === t ? "bg-[#5A92C9] text-white font-semibold" : "hover:bg-muted"}`}
                    >
                      {t === "light" && <Sun size={14} />}
                      {t === "dark" && <Moon size={14} />}
                      {t === "system" && <Monitor size={14} />}
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* User pill */}
            {user ? (
              <div className="flex items-center gap-2">
                <div className="hidden md:flex flex-col items-end text-xs leading-tight">
                  <span className="font-semibold text-foreground truncate max-w-[160px]">{user.display_name}</span>
                  <span className="text-[11px] text-muted-foreground truncate max-w-[160px]">{user.email}</span>
                </div>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${roleColor[user.role]}`}>
                  {roleLabel[user.role]}
                </span>
                <button
                  onClick={logout}
                  className="touch-target inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-muted hover:bg-muted/80 text-foreground focus-ring"
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut size={14} />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Lock size={13} /> Demo mode
              </span>
            )}

            {/* Mobile menu button */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="lg:hidden touch-target inline-flex items-center justify-center p-2 rounded-xl border border-border bg-card hover:bg-muted focus-ring"
              aria-label="Toggle navigation"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* Desktop nav bar */}
        <nav aria-label="Primary" className="hidden lg:block border-t border-border bg-muted/40 px-4 sm:px-6">
          <div className="mx-auto max-w-7xl flex items-center gap-1 overflow-x-auto py-1.5">
            {navItems.map(item => {
              const active = item.href === "/" ? location === "/" : location.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-xl whitespace-nowrap focus-ring ${
                    active ? "bg-[#5A92C9] text-white shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-card"
                  }`}
                >
                  <Icon size={14} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Mobile drawer */}
        {mobileOpen && (
          <nav aria-label="Primary" className="lg:hidden border-t border-border bg-card px-4 py-3 space-y-1">
            {navItems.map(item => {
              const active = item.href === "/" ? location === "/" : location.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 text-sm font-semibold rounded-xl touch-target ${
                    active ? "bg-[#5A92C9] text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      {/* Main content */}
      <main id="maincontent" tabIndex={-1} className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-6 focus:outline-none">
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-card px-4 sm:px-6 py-4 text-xs text-muted-foreground no-print mt-auto">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>© {new Date().getFullYear()} {companyName} · {brand?.tagline || "HPP Reporting Portal"}</span>
          <span className="flex items-center gap-1.5">
            <Lock size={13} className="text-emerald-500" />
            Protected by role-based access, MFA and immutable audit logging
          </span>
        </div>
      </footer>
    </div>
  );
}
