import React from "react";
import { Route, Switch, Redirect } from "wouter";
import { ThemeProvider } from "./contexts/ThemeContext";
import { BrandingProvider } from "./contexts/BrandingContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/DashboardPage";
import { MetricsEntryPage } from "./pages/MetricsEntryPage";
import { ReportsPage } from "./pages/ReportsPage";
import { UsersPage } from "./pages/UsersPage";
import { AuditCenterPage } from "./pages/AuditCenterPage";
import { SiemPage } from "./pages/SiemPage";
import { EmailEnginePage } from "./pages/EmailEnginePage";
import { BackupPage } from "./pages/BackupPage";
import { BrandingPage } from "./pages/BrandingPage";
import { SecurityPage } from "./pages/SecurityPage";
import { ViewerPortalPage } from "./pages/ViewerPortalPage";
import { LoginPage } from "./pages/LoginPage";

function Shell() {
  const { stage, isViewOnly, isSuperAdmin, isAdmin, isManager, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (stage !== "full") {
    return <LoginPage />;
  }

  // View Only role sees simplified portal
  if (isViewOnly) {
    return (
      <Layout>
        <Switch>
          <Route path="/" component={ViewerPortalPage} />
          <Route path="/reports" component={ViewerPortalPage} />
          <Route><Redirect to="/" /></Route>
        </Switch>
      </Layout>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/metrics" component={MetricsEntryPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/users" component={isAdmin || isSuperAdmin ? UsersPage : () => <Redirect to="/" />} />
        <Route path="/audit" component={isAdmin || isSuperAdmin ? AuditCenterPage : () => <Redirect to="/" />} />
        <Route path="/siem" component={isSuperAdmin ? SiemPage : () => <Redirect to="/" />} />
        <Route path="/email" component={isSuperAdmin ? EmailEnginePage : () => <Redirect to="/" />} />
        <Route path="/backups" component={isAdmin || isSuperAdmin ? BackupPage : () => <Redirect to="/" />} />
        <Route path="/branding" component={isSuperAdmin ? BrandingPage : () => <Redirect to="/" />} />
        <Route path="/security" component={isSuperAdmin ? SecurityPage : () => <Redirect to="/" />} />
        <Route>
          <div className="rounded-2xl bg-card border border-border p-12 text-center text-xs text-muted-foreground">
            Page not found. <a href="/" className="font-semibold text-[#5A92C9] hover:underline">Return to dashboard</a>
          </div>
        </Route>
      </Switch>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="system" switchable>
      <BrandingProvider>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </BrandingProvider>
    </ThemeProvider>
  );
}
