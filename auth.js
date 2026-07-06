// auth.js
// Shared across all pages. Depends on config.js having already run
// (window.db must exist). Handles session state, nav visibility,
// and page-level access guards.

/**
 * Returns the current logged-in user, or null if not logged in
 * or no database is configured.
 */
async function getCurrentUser() {
  if (!window.db) return null;
  const { data, error } = await window.db.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/**
 * Returns the current user's profile row (includes role), or null.
 */
async function getCurrentProfile() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await window.db
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) return null;
  return data;
}

/**
 * Shows/hides the standard nav links based on login + role.
 * Expects these element IDs to exist in the page's header:
 * navLogin, navSignup, navDashboard, navAdmin, navLogout, navEmail
 */
async function refreshAuthNav() {
  const navLogin = document.getElementById('navLogin');
  const navSignup = document.getElementById('navSignup');
  const navDashboard = document.getElementById('navDashboard');
  const navAdmin = document.getElementById('navAdmin');
  const navLogout = document.getElementById('navLogout');
  const navEmail = document.getElementById('navEmail');

  const profile = await getCurrentProfile();

  const loggedIn = !!profile;

  if (navLogin) navLogin.hidden = loggedIn;
  if (navSignup) navSignup.hidden = loggedIn;
  if (navDashboard) navDashboard.hidden = !loggedIn;
  if (navAdmin) navAdmin.hidden = !loggedIn || profile.role !== 'admin';
  if (navLogout) navLogout.hidden = !loggedIn;
  if (navEmail) {
    navEmail.hidden = !loggedIn;
    navEmail.textContent = loggedIn ? profile.email : '';
  }

  if (navLogout) {
    navLogout.onclick = async () => {
      await window.db.auth.signOut();
      window.location.href = 'index.html';
    };
  }

  return profile;
}

/**
 * Call at the top of a page that REQUIRES login (e.g. dashboard.html).
 * Redirects to login.html if nobody is signed in.
 */
async function requireLogin() {
  const profile = await refreshAuthNav();
  if (!profile) {
    window.location.href = 'login.html';
    return null;
  }
  return profile;
}

/**
 * Call at the top of a page that REQUIRES admin (admin.html).
 * Redirects non-admins back to the homepage.
 */
async function requireAdmin() {
  const profile = await refreshAuthNav();
  if (!profile) {
    window.location.href = 'login.html';
    return null;
  }
  if (profile.role !== 'admin') {
    window.location.href = 'index.html';
    return null;
  }
  return profile;
}

document.addEventListener('DOMContentLoaded', refreshAuthNav);