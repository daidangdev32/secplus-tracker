// firebase-config.js
//
// Paste the values from your Firebase project here (README → Stage 2, step 5).
// Project Overview → web app `</>` → "SDK setup and configuration" → "Config".
//
// These values are NOT secrets. Firebase web API keys identify your project to
// Google; access is controlled by the Firestore security rules in the README,
// not by hiding this file. It is fine that this file is public on GitHub Pages.
//
// Replace every "PASTE_..." string below, then save. Nothing else needs editing.

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Quick check used by the app to show a helpful message if you forgot to fill
// this in. Leave as-is.
export const isConfigured = !String(firebaseConfig.apiKey).startsWith("PASTE_");
