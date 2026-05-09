import { initializeApp, getApps } from "firebase/app";
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  inMemoryPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  setPersistence,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize once on the client
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = (() => {
  if (typeof window === "undefined") {
    return getAuth(app);
  }
  try {
    return initializeAuth(app, {
      // Try robust persistence fallbacks for browsers with strict privacy/storage
      // policies (Safari/Firefox private mode, enterprise restrictions, etc).
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence,
        inMemoryPersistence,
      ],
    });
  } catch {
    return getAuth(app);
  }
})();

export async function prepareAuthPersistence(remember: boolean): Promise<void> {
  const chain = remember
    ? [browserLocalPersistence, browserSessionPersistence, inMemoryPersistence]
    : [browserSessionPersistence, browserLocalPersistence, inMemoryPersistence];

  for (const persistence of chain) {
    try {
      await setPersistence(auth, persistence);
      return;
    } catch {
      // Try next persistence option.
    }
  }
}
