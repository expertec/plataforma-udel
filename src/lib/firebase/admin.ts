import * as admin from "firebase-admin";

let app: admin.app.App | null = null;

export function getAdminApp(): admin.app.App {
  if (app) return app;

  // Inicializar con credenciales del entorno
  if (!admin.apps.length) {
    // Opción 1: Usando service account key (recomendado para desarrollo local)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
      const serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY
      );
      app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    // Opción 2: Usando variables individuales (para producción/Vercel)
    else if (
      process.env.FIREBASE_ADMIN_PROJECT_ID &&
      process.env.FIREBASE_ADMIN_PRIVATE_KEY &&
      process.env.FIREBASE_ADMIN_CLIENT_EMAIL
    ) {
      app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
        }),
      });
    }
    // Fallback: credenciales por defecto (funciona en Cloud Functions/App Engine)
    else {
      app = admin.initializeApp();
    }
  } else {
    app = admin.apps[0] as admin.app.App;
  }

  return app;
}

export function getAdminAuth(): admin.auth.Auth {
  return getAdminApp().auth();
}

export function getAdminFirestore(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}
