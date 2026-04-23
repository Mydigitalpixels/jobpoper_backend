import { useEffect, useMemo, useState } from "react";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  `${window.location.origin.replace(/\/$/, "")}/api`;

const UPLOADS_BASE_URL =
  import.meta.env.VITE_UPLOADS_BASE_URL ||
  `${window.location.origin.replace(/\/$/, "")}/uploads`;

const menuItems = [
  { id: "dashboard", label: "Dashboard" },
  { id: "users", label: "Users" },
  { id: "jobs", label: "Jobs" },
  { id: "verifications", label: "Verification Requests" },
];

const dashboardFallback = {
  stats: {
    totalUsers: 0,
    totalJobs: 0,
    activeJobs: 0,
    verifiedUsers: 0,
    pendingVerificationRequests: 0,
  },
  recentUsers: [],
  recentJobs: [],
};

const bootstrapFallback = {
  bootstrapAvailable: false,
  adminCount: 0,
};

async function apiRequest(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || "Request failed");
  }

  return payload;
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [adminUser, setAdminUser] = useState(() => {
    const stored = localStorage.getItem("adminUser");
    return stored ? JSON.parse(stored) : null;
  });
  const [activeView, setActiveView] = useState("dashboard");
  const [authError, setAuthError] = useState("");
  const [pageError, setPageError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupStatus, setSetupStatus] = useState(bootstrapFallback);
  const [loginState, setLoginState] = useState({ phoneNumber: "", pin: "" });
  const [bootstrapState, setBootstrapState] = useState({
    fullName: "",
    email: "",
    phoneNumber: "",
    pin: "",
  });
  const [dashboard, setDashboard] = useState(dashboardFallback);
  const [users, setUsers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [verificationRequests, setVerificationRequests] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJob, setSelectedJob] = useState(null);
  const [selectedVerificationId, setSelectedVerificationId] = useState("");
  const [selectedVerification, setSelectedVerification] = useState(null);
  const [reviewForm, setReviewForm] = useState({ status: "approved", reviewNotes: "" });
  const [actionMessage, setActionMessage] = useState("");

  const statsCards = useMemo(
    () => [
      { label: "Total Users", value: dashboard.stats.totalUsers },
      { label: "Total Jobs", value: dashboard.stats.totalJobs },
      { label: "Active Jobs", value: dashboard.stats.activeJobs },
      { label: "Verified Users", value: dashboard.stats.verifiedUsers },
      {
        label: "Pending Requests",
        value: dashboard.stats.pendingVerificationRequests,
      },
    ],
    [dashboard],
  );

  const loadSetupStatus = async () => {
    try {
      setSetupLoading(true);
      const payload = await apiRequest("/admin/setup-status");
      setSetupStatus(payload?.data || bootstrapFallback);
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setSetupLoading(false);
    }
  };

  const loadProtectedData = async (authToken, options = {}) => {
    const { keepSelections = true } = options;

    setLoading(true);
    setPageError("");

    try {
      const [mePayload, dashboardPayload, usersPayload, jobsPayload, verificationPayload] =
        await Promise.all([
          apiRequest("/auth/me", { token: authToken }),
          apiRequest("/admin/dashboard", { token: authToken }),
          apiRequest("/admin/users", { token: authToken }),
          apiRequest("/admin/jobs", { token: authToken }),
          apiRequest("/admin/verifications", { token: authToken }),
        ]);

      const currentUser = mePayload?.data?.user || null;

      if (!currentUser || currentUser.role !== "admin") {
        throw new Error("This account is not allowed to access the admin panel");
      }

      const nextUsers = usersPayload?.data?.users || [];
      const nextJobs = jobsPayload?.data?.jobs || [];
      const nextRequests = verificationPayload?.data?.requests || [];

      setAdminUser(currentUser);
      localStorage.setItem("adminUser", JSON.stringify(currentUser));
      setDashboard(dashboardPayload?.data || dashboardFallback);
      setUsers(nextUsers);
      setJobs(nextJobs);
      setVerificationRequests(nextRequests);

      const nextUserId =
        keepSelections && selectedUserId
          ? selectedUserId
          : nextUsers[0]?.id || "";
      const nextJobId =
        keepSelections && selectedJobId
          ? selectedJobId
          : nextJobs[0]?.id || "";
      const nextVerificationId =
        keepSelections && selectedVerificationId
          ? selectedVerificationId
          : nextRequests[0]?.id || "";

      setSelectedUserId(nextUserId);
      setSelectedJobId(nextJobId);
      setSelectedVerificationId(nextVerificationId);

      if (nextUserId) {
        await loadUserDetail(authToken, nextUserId);
      } else {
        setSelectedUser(null);
      }

      if (nextJobId) {
        await loadJobDetail(authToken, nextJobId);
      } else {
        setSelectedJob(null);
      }

      if (nextVerificationId) {
        const activeRequest =
          nextRequests.find((request) => request.id === nextVerificationId) ||
          nextRequests[0];
        setSelectedVerification(activeRequest || null);
        setReviewForm((current) => ({
          ...current,
          reviewNotes: activeRequest?.verification?.reviewNotes || "",
        }));
      } else {
        setSelectedVerification(null);
      }
    } catch (error) {
      setPageError(error.message);
      if (/not allowed|Not authorized|token|access/i.test(error.message)) {
        handleLogout();
      }
    } finally {
      setLoading(false);
    }
  };

  const loadUserDetail = async (authToken, userId) => {
    const payload = await apiRequest(`/admin/users/${userId}`, { token: authToken });
    setSelectedUser(payload?.data?.user || null);
  };

  const loadJobDetail = async (authToken, jobId) => {
    const payload = await apiRequest(`/admin/jobs/${jobId}`, { token: authToken });
    setSelectedJob(payload?.data?.job || null);
  };

  useEffect(() => {
    if (token) {
      loadProtectedData(token);
      return;
    }

    loadSetupStatus();
  }, [token]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setAuthError("");
    setActionMessage("");
    setLoading(true);

    try {
      const payload = await apiRequest("/auth/login", {
        method: "POST",
        body: loginState,
      });

      const nextToken = payload?.data?.token || "";
      const nextUser = payload?.data?.user || null;

      if (!nextToken || !nextUser) {
        throw new Error("Login response is incomplete");
      }

      if (nextUser.role !== "admin") {
        throw new Error("This account is not allowed to access the admin panel");
      }

      localStorage.setItem("adminToken", nextToken);
      localStorage.setItem("adminUser", JSON.stringify(nextUser));
      setToken(nextToken);
      setAdminUser(nextUser);
      setLoginState({ phoneNumber: "", pin: "" });
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBootstrap = async (event) => {
    event.preventDefault();
    setAuthError("");
    setActionMessage("");
    setLoading(true);

    try {
      const payload = await apiRequest("/admin/bootstrap", {
        method: "POST",
        body: bootstrapState,
      });

      const nextToken = payload?.data?.token || "";
      const nextUser = payload?.data?.user || null;

      if (!nextToken || !nextUser) {
        throw new Error("Admin bootstrap response is incomplete");
      }

      localStorage.setItem("adminToken", nextToken);
      localStorage.setItem("adminUser", JSON.stringify(nextUser));
      setToken(nextToken);
      setAdminUser(nextUser);
      setActionMessage("First admin account created successfully.");
      setBootstrapState({
        fullName: "",
        email: "",
        phoneNumber: "",
        pin: "",
      });
    } catch (error) {
      setAuthError(error.message);
      await loadSetupStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("adminToken");
    localStorage.removeItem("adminUser");
    setToken("");
    setAdminUser(null);
    setDashboard(dashboardFallback);
    setUsers([]);
    setJobs([]);
    setVerificationRequests([]);
    setSelectedUserId("");
    setSelectedUser(null);
    setSelectedJobId("");
    setSelectedJob(null);
    setSelectedVerificationId("");
    setSelectedVerification(null);
    setActiveView("dashboard");
  };

  const handleUserSelect = async (userId) => {
    setSelectedUserId(userId);
    await loadUserDetail(token, userId);
  };

  const handleJobSelect = async (jobId) => {
    setSelectedJobId(jobId);
    await loadJobDetail(token, jobId);
  };

  const handleVerificationSelect = (request) => {
    setSelectedVerificationId(request.id);
    setSelectedVerification(request);
    setReviewForm((current) => ({
      ...current,
      reviewNotes: request.verification?.reviewNotes || "",
    }));
  };

  const handleReviewSubmit = async (status) => {
    if (!selectedVerificationId) {
      return;
    }

    setLoading(true);
    setActionMessage("");
    setPageError("");

    try {
      await apiRequest(`/admin/verifications/${selectedVerificationId}/review`, {
        token,
        method: "PUT",
        body: {
          status,
          reviewNotes: reviewForm.reviewNotes,
        },
      });

      setActionMessage(
        `Verification request ${status === "approved" ? "approved" : "rejected"} successfully.`,
      );
      setReviewForm((current) => ({ ...current, status }));
      await loadProtectedData(token, { keepSelections: true });
    } catch (error) {
      setPageError(error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!token || !adminUser) {
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <div className="brand-mark">JP</div>
          <p className="eyebrow">JobPoper Admin Panel</p>
          <h1>Sign in to manage the platform</h1>
          <p className="auth-copy">
            Login with an <strong>admin</strong> account. If this is a fresh
            server and no admin exists yet, create the first one below.
          </p>

          <form className="auth-form" onSubmit={handleLogin}>
            <label>
              Phone Number
              <input
                type="text"
                placeholder="+923001234567"
                value={loginState.phoneNumber}
                onChange={(event) =>
                  setLoginState((current) => ({
                    ...current,
                    phoneNumber: event.target.value,
                  }))
                }
              />
            </label>

            <label>
              PIN
              <input
                type="password"
                placeholder="1234"
                value={loginState.pin}
                onChange={(event) =>
                  setLoginState((current) => ({
                    ...current,
                    pin: event.target.value,
                  }))
                }
              />
            </label>

            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? "Signing in..." : "Login"}
            </button>
          </form>

          <div className="bootstrap-panel">
            <div className="panel-header compact">
              <h3>First Admin Setup</h3>
              <span>
                {setupLoading
                  ? "Checking..."
                  : setupStatus.bootstrapAvailable
                    ? "Available"
                    : "Locked"}
              </span>
            </div>
            <p className="muted-copy">
              {setupStatus.bootstrapAvailable
                ? "No admin account exists yet. You can bootstrap the first admin here."
                : `Admin bootstrap is disabled because ${setupStatus.adminCount} admin account${
                    setupStatus.adminCount === 1 ? "" : "s"
                  } already exist.`}
            </p>

            <form className="auth-form" onSubmit={handleBootstrap}>
              <label>
                Full Name
                <input
                  type="text"
                  placeholder="Admin User"
                  value={bootstrapState.fullName}
                  onChange={(event) =>
                    setBootstrapState((current) => ({
                      ...current,
                      fullName: event.target.value,
                    }))
                  }
                  disabled={!setupStatus.bootstrapAvailable || loading}
                />
              </label>

              <label>
                Email
                <input
                  type="email"
                  placeholder="admin@example.com"
                  value={bootstrapState.email}
                  onChange={(event) =>
                    setBootstrapState((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  disabled={!setupStatus.bootstrapAvailable || loading}
                />
              </label>

              <label>
                Phone Number
                <input
                  type="text"
                  placeholder="+923001234567"
                  value={bootstrapState.phoneNumber}
                  onChange={(event) =>
                    setBootstrapState((current) => ({
                      ...current,
                      phoneNumber: event.target.value,
                    }))
                  }
                  disabled={!setupStatus.bootstrapAvailable || loading}
                />
              </label>

              <label>
                PIN
                <input
                  type="password"
                  placeholder="1234"
                  value={bootstrapState.pin}
                  onChange={(event) =>
                    setBootstrapState((current) => ({
                      ...current,
                      pin: event.target.value,
                    }))
                  }
                  disabled={!setupStatus.bootstrapAvailable || loading}
                />
              </label>

              <button
                className="secondary-button wide"
                type="submit"
                disabled={!setupStatus.bootstrapAvailable || loading}
              >
                {loading ? "Creating..." : "Create First Admin"}
              </button>
            </form>
          </div>

          {authError ? <p className="error-text">{authError}</p> : null}
          {actionMessage ? <p className="success-text">{actionMessage}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-block">
            <div className="brand-mark">JP</div>
            <div>
              <p className="eyebrow">Operations</p>
              <h2>JobPoper Admin</h2>
            </div>
          </div>

          <nav className="nav-menu">
            {menuItems.map((item) => (
              <button
                key={item.id}
                className={item.id === activeView ? "nav-link active" : "nav-link"}
                onClick={() => setActiveView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar-footer">
          <p className="user-name">{adminUser.profile?.fullName || adminUser.phoneNumber}</p>
          <p className="user-role">Signed in as {adminUser.role}</p>
          <button className="secondary-button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </aside>

      <main className="content-area">
        <header className="topbar">
          <div>
            <p className="eyebrow">Live overview</p>
            <h1>{menuItems.find((item) => item.id === activeView)?.label}</h1>
          </div>
          <div className="status-pill">API: {API_BASE_URL}</div>
        </header>

        {pageError ? <div className="page-alert">{pageError}</div> : null}
        {actionMessage ? <div className="page-success">{actionMessage}</div> : null}

        {activeView === "dashboard" ? (
          <section className="view-grid">
            <div className="stats-grid">
              {statsCards.map((card) => (
                <article key={card.label} className="stat-card">
                  <p>{card.label}</p>
                  <strong>{card.value}</strong>
                </article>
              ))}
            </div>

            <div className="panel-grid">
              <section className="panel">
                <div className="panel-header">
                  <h3>Recent Users</h3>
                  <span>{dashboard.recentUsers.length}</span>
                </div>
                <SimpleTable
                  columns={["Name", "Phone", "Verified", "Verification Status"]}
                  rows={dashboard.recentUsers.map((user) => [
                    user.fullName || "No name",
                    user.phoneNumber,
                    user.isVerified ? "Yes" : "No",
                    user.verificationStatus,
                  ])}
                  emptyMessage="No users found yet."
                />
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h3>Recent Jobs</h3>
                  <span>{dashboard.recentJobs.length}</span>
                </div>
                <SimpleTable
                  columns={["Title", "Type", "Urgency", "Status", "Posted By"]}
                  rows={dashboard.recentJobs.map((job) => [
                    job.title,
                    job.jobType,
                    job.urgency,
                    job.status,
                    job.postedBy.fullName || job.postedBy.phoneNumber || "Unknown",
                  ])}
                  emptyMessage="No jobs found yet."
                />
              </section>
            </div>
          </section>
        ) : null}

        {activeView === "users" ? (
          <section className="split-layout">
            <section className="panel">
              <div className="panel-header">
                <h3>Platform Users</h3>
                <span>{users.length}</span>
              </div>
              <SelectableList
                items={users}
                selectedId={selectedUserId}
                onSelect={(user) => handleUserSelect(user.id)}
                renderPrimary={(user) => user.fullName || user.phoneNumber}
                renderSecondary={(user) =>
                  `${user.phoneNumber} • ${user.isVerified ? "Verified" : "Pending"}`
                }
              />
            </section>

            <section className="panel detail-panel">
              <div className="panel-header">
                <h3>User Detail</h3>
                <span>{selectedUser ? selectedUser.role : "-"}</span>
              </div>
              {selectedUser ? (
                <div className="detail-stack">
                  <DetailRow label="Full Name" value={selectedUser.profile?.fullName || "No name"} />
                  <DetailRow label="Phone" value={selectedUser.phoneNumber} />
                  <DetailRow label="Email" value={selectedUser.profile?.email || "-"} />
                  <DetailRow label="Location" value={selectedUser.profile?.location || "-"} />
                  <DetailRow
                    label="Phone Verified"
                    value={selectedUser.isPhoneVerified ? "Yes" : "No"}
                  />
                  <DetailRow
                    label="Admin Verified"
                    value={selectedUser.isVerified ? "Yes" : "No"}
                  />
                  <DetailRow
                    label="Verification Status"
                    value={selectedUser.verification?.status || "not_submitted"}
                  />
                  <DetailRow
                    label="Profile Complete"
                    value={selectedUser.profile?.isProfileComplete ? "Yes" : "No"}
                  />
                  <DetailRow label="Created" value={formatDate(selectedUser.createdAt)} />
                  <DetailRow label="Last Login" value={formatDate(selectedUser.lastLogin)} />
                </div>
              ) : (
                <EmptyPanel message="Choose a user to see details." />
              )}
            </section>
          </section>
        ) : null}

        {activeView === "jobs" ? (
          <section className="split-layout">
            <section className="panel">
              <div className="panel-header">
                <h3>Jobs</h3>
                <span>{jobs.length}</span>
              </div>
              <SelectableList
                items={jobs}
                selectedId={selectedJobId}
                onSelect={(job) => handleJobSelect(job.id)}
                renderPrimary={(job) => job.title}
                renderSecondary={(job) =>
                  `${job.jobType} • ${job.urgency} • ${job.status}`
                }
              />
            </section>

            <section className="panel detail-panel">
              <div className="panel-header">
                <h3>Job Detail</h3>
                <span>{selectedJob ? selectedJob.status : "-"}</span>
              </div>
              {selectedJob ? (
                <div className="detail-stack">
                  <DetailRow label="Title" value={selectedJob.title} />
                  <DetailRow label="Type" value={selectedJob.jobType} />
                  <DetailRow label="Urgency" value={selectedJob.urgency} />
                  <DetailRow label="Cost" value={selectedJob.cost} />
                  <DetailRow label="Response" value={selectedJob.responsePreference} />
                  <DetailRow label="Scheduled Date" value={formatDate(selectedJob.scheduledDate)} />
                  <DetailRow label="Scheduled Time" value={selectedJob.scheduledTime} />
                  <DetailRow
                    label="Posted By"
                    value={
                      selectedJob.postedBy?.fullName ||
                      selectedJob.postedBy?.phoneNumber ||
                      "Unknown"
                    }
                  />
                  <DetailRow
                    label="Interested Users"
                    value={String(selectedJob.interestedUsers?.length || 0)}
                  />
                  <DetailRow
                    label="Description"
                    value={selectedJob.description || "No description"}
                    multiline
                  />
                  <DetailRow
                    label="Location"
                    value={formatLocation(selectedJob.location, selectedJob.jobType)}
                    multiline
                  />
                </div>
              ) : (
                <EmptyPanel message="Choose a job to see details." />
              )}
            </section>
          </section>
        ) : null}

        {activeView === "verifications" ? (
          <section className="split-layout">
            <section className="panel">
              <div className="panel-header">
                <h3>Verification Requests</h3>
                <span>{verificationRequests.length}</span>
              </div>
              <SelectableList
                items={verificationRequests}
                selectedId={selectedVerificationId}
                onSelect={handleVerificationSelect}
                renderPrimary={(request) => request.fullName || request.phoneNumber}
                renderSecondary={(request) =>
                  `${request.verification?.status || "not_submitted"} • ${request.phoneNumber}`
                }
              />
            </section>

            <section className="panel detail-panel">
              <div className="panel-header">
                <h3>Review Request</h3>
                <span>{selectedVerification?.verification?.status || "-"}</span>
              </div>
              {selectedVerification ? (
                <div className="detail-stack">
                  <DetailRow
                    label="User"
                    value={selectedVerification.fullName || selectedVerification.phoneNumber}
                  />
                  <DetailRow label="Phone" value={selectedVerification.phoneNumber} />
                  <DetailRow
                    label="Submitted"
                    value={formatDate(selectedVerification.verification?.submittedAt)}
                  />
                  <DetailRow
                    label="Admin Verified"
                    value={selectedVerification.isVerified ? "Yes" : "No"}
                  />

                  <div className="image-grid">
                    <ImageCard
                      label="Selfie"
                      src={buildUploadUrl(selectedVerification.verification?.selfieImage)}
                    />
                    <ImageCard
                      label="Photo ID"
                      src={buildUploadUrl(selectedVerification.verification?.idPhotoImage)}
                    />
                  </div>

                  <label className="detail-label">
                    Review Notes
                    <textarea
                      rows="4"
                      value={reviewForm.reviewNotes}
                      onChange={(event) =>
                        setReviewForm((current) => ({
                          ...current,
                          reviewNotes: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <div className="action-row">
                    <button
                      className="primary-button"
                      onClick={() => handleReviewSubmit("approved")}
                      disabled={loading}
                    >
                      Approve
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => handleReviewSubmit("rejected")}
                      disabled={loading}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : (
                <EmptyPanel message="Choose a verification request to review it." />
              )}
            </section>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function SelectableList({
  items,
  selectedId,
  onSelect,
  renderPrimary,
  renderSecondary,
}) {
  if (!items.length) {
    return <div className="empty-state card-empty">No records available.</div>;
  }

  return (
    <div className="list-stack">
      {items.map((item) => (
        <button
          key={item.id}
          className={item.id === selectedId ? "list-card active" : "list-card"}
          onClick={() => onSelect(item)}
        >
          <strong>{renderPrimary(item)}</strong>
          <span>{renderSecondary(item)}</span>
        </button>
      ))}
    </div>
  );
}

function SimpleTable({ columns, rows, emptyMessage }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={`${row.join("-")}-${index}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${cell}-${cellIndex}`}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="empty-state">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DetailRow({ label, value, multiline = false }) {
  return (
    <div className={multiline ? "detail-row multi" : "detail-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyPanel({ message }) {
  return <div className="empty-state card-empty">{message}</div>;
}

function ImageCard({ label, src }) {
  return (
    <div className="image-card">
      <p>{label}</p>
      {src ? <img src={src} alt={label} /> : <div className="image-placeholder">No image</div>}
    </div>
  );
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function formatLocation(location, jobType) {
  if (!location) {
    return "No location";
  }

  if (jobType === "Pickup") {
    return `${location.source?.fullAddress || "-"} -> ${location.destination?.fullAddress || "-"}`;
  }

  return location.fullAddress || location.name || "No location";
}

function buildUploadUrl(path) {
  if (!path) {
    return "";
  }

  return `${UPLOADS_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

export default App;
