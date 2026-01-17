import { getApps, initializeApp } from "firebase/app";
import {
  Auth,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  updatePassword,
} from "firebase/auth";
import { doc, serverTimestamp, setDoc, getDoc } from "firebase/firestore";
import { db } from "./firestore";
import { UserRole } from "./roles";

type CreateAccountInput = {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
  createdBy?: string | null;
  phone?: string;
};

let managementAuth: Auth | null = null;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

function getManagementAuth(): Auth {
  if (managementAuth) return managementAuth;
  const secondaryApp =
    getApps().find((app) => app.name === "MANAGEMENT") ??
    initializeApp(firebaseConfig, "MANAGEMENT");
  managementAuth = getAuth(secondaryApp);
  return managementAuth;
}

export async function createAccountWithRole(input: CreateAccountInput): Promise<{ uid: string }> {
  const { email, password, displayName, role, createdBy, phone } = input;
  const auth = getManagementAuth();
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) {
      await updateProfile(cred.user, { displayName });
    }

    await setDoc(
      doc(db, "users", cred.user.uid),
      {
        email,
        displayName,
        name: displayName,
        role,
        mustChangePassword: role === "student",
        createdAt: serverTimestamp(),
        createdBy: createdBy ?? null,
        status: "active",
        provider: "password",
        phone: phone ?? null,
      },
      { merge: true },
    );

    // Evitamos que el usuario creado quede firmado en la app secundaria.
    try {
      await signOut(auth);
    } catch {
      // no action needed
    }

    return { uid: cred.user.uid };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? "";
    if (code !== "auth/email-already-in-use") {
      throw err;
    }
    // Intentar iniciar sesión con el password proporcionado para obtener el uid y actualizar el rol.
    try {
      const existingCred = await signInWithEmailAndPassword(auth, email, password);
      if (displayName) {
        await updateProfile(existingCred.user, { displayName });
      }
      await setDoc(
        doc(db, "users", existingCred.user.uid),
        {
          email,
          displayName,
          name: displayName,
          role,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: createdBy ?? null,
          status: "active",
          provider: "password",
          phone: phone ?? null,
        },
        { merge: true },
      );
      try {
        await signOut(auth);
      } catch {
        // ignore
      }
      return { uid: existingCred.user.uid };
    } catch (signInErr: unknown) {
      const signInCode = (signInErr as { code?: string })?.code ?? "";
      if (
        signInCode === "auth/invalid-credential" ||
        signInCode === "auth/wrong-password" ||
        signInCode === "auth/user-mismatch" ||
        signInCode === "auth/user-disabled"
      ) {
        const mapped = new Error("El correo ya está registrado con otra credencial.");
        (mapped as { code?: string }).code = "auth/email-already-in-use";
        throw mapped;
      }
      throw signInErr;
    }
  }
}

export async function updateUserPassword(params: {
  email: string;
  oldPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; message?: string }> {
  const { email, oldPassword, newPassword } = params;
  const auth = getManagementAuth();

  try {
    // Intentar iniciar sesión con la contraseña anterior
    const cred = await signInWithEmailAndPassword(auth, email, oldPassword);

    // Actualizar la contraseña
    await updatePassword(cred.user, newPassword);

    // Actualizar Firestore para indicar que debe cambiar contraseña
    const userDoc = await getDoc(doc(db, "users", cred.user.uid));
    if (userDoc.exists()) {
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          mustChangePassword: true,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    // Cerrar sesión
    await signOut(auth);

    return { success: true };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? "";
    let message = "No se pudo actualizar la contraseña";

    if (code === "auth/wrong-password") {
      message = "Contraseña anterior incorrecta";
    } else if (code === "auth/user-not-found") {
      message = "Usuario no encontrado";
    } else if (code === "auth/weak-password") {
      message = "La nueva contraseña es muy débil";
    }

    return { success: false, message };
  }
}
