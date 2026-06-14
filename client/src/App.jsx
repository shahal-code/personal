import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import SecurityActivityPage from "./pages/SecurityActivityPage.jsx";
import GlobalSearchPage from "./pages/GlobalSearchPage.jsx";

function ProtectedRoute({ children }) {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="screen-center">
        <div className="loading-card">Checking session...</div>
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function PublicRoute({ children }) {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="screen-center">
        <div className="loading-card">Checking session...</div>
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/app" replace />;
  }

  return children;
}

function AppRoutes() {
  const { status } = useAuth();

  return (
    <Routes>
      <Route
        path="/"
        element={
          status === "loading" ? (
            <div className="screen-center">
              <div className="loading-card">Checking session...</div>
            </div>
          ) : (
            <Navigate to={status === "authenticated" ? "/app" : "/login"} replace />
          )
        }
      />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/app/security"
        element={
          <ProtectedRoute>
            <SecurityActivityPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/app/search"
        element={
          <ProtectedRoute>
            <GlobalSearchPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
