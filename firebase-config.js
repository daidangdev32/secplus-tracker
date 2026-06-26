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
  apiKey: "AIzaSyA3ZrPX9PqKh3qArFhiZhltj6w7uj5NnNI",
  authDomain: "test-d4e75.firebaseapp.com",
  projectId: "test-d4e75",
  storageBucket: "test-d4e75.firebasestorage.app",
  messagingSenderId: "899770605854",
  appId: "1:899770605854:web:687b4825bd8f6c5678a90f",
  measurementId: "G-761M8N5LR2",
};

// Quick check used by the app to show a helpful message if you forgot to fill
// this in. Leave as-is.
export const isConfigured = !String(firebaseConfig.apiKey).startsWith("PASTE_");
