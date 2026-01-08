# Configuración de Firebase Admin SDK

Para usar la funcionalidad de actualización masiva de contraseñas, necesitas configurar Firebase Admin SDK.

## Pasos para Configurar

### 1. Obtener las Credenciales de Servicio

1. Ve a [Firebase Console](https://console.firebase.google.com/)
2. Selecciona tu proyecto
3. Ve a **Project Settings** (⚙️ en la barra lateral)
4. Ve a la pestaña **Service Accounts**
5. Click en **Generate New Private Key**
6. Se descargará un archivo JSON con las credenciales

### 2. Configurar Variables de Entorno

Tienes 2 opciones:

#### Opción A: JSON Completo (Desarrollo Local)

Copia todo el contenido del archivo JSON y agrégalo a `.env.local`:

```bash
FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"tu-proyecto",...}'
```

#### Opción B: Variables Individuales (Producción/Vercel)

Extrae estos valores del JSON y agrégalos a `.env.local`:

```bash
FIREBASE_ADMIN_PROJECT_ID=tu-proyecto-id
FIREBASE_ADMIN_CLIENT_EMAIL=firebase-adminsdk-xxxxx@tu-proyecto.iam.gserviceaccount.com
FIREBASE_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIB...\n-----END PRIVATE KEY-----\n"
```

**IMPORTANTE**: La private key debe incluir los `\n` para los saltos de línea.

### 3. Agregar `.env.local` al .gitignore

Asegúrate de que `.env.local` esté en tu `.gitignore`:

```
.env.local
.env*.local
```

### 4. Desplegar en Vercel

Si usas Vercel:

1. Ve a **Project Settings** → **Environment Variables**
2. Agrega las 3 variables (Opción B):
   - `FIREBASE_ADMIN_PROJECT_ID`
   - `FIREBASE_ADMIN_CLIENT_EMAIL`
   - `FIREBASE_ADMIN_PRIVATE_KEY`
3. Asegúrate de que `FIREBASE_ADMIN_PRIVATE_KEY` tenga los `\n` literales (Vercel los manejará correctamente)

## Seguridad

⚠️ **NUNCA** expongas las credenciales de Firebase Admin:
- ❌ No las subas a GitHub
- ❌ No las incluyas en código del cliente
- ❌ No las pongas en variables `NEXT_PUBLIC_*`
- ✅ Solo úsalas en API Routes (código de servidor)

## Verificar que Funciona

1. Reinicia el servidor de desarrollo
2. Ve a la página de Alumnos
3. Intenta actualizar contraseñas con un Excel
4. Si hay errores, revisa los logs en la consola del servidor

## Troubleshooting

### Error: "Firebase Admin not initialized"
- Verifica que las variables de entorno estén configuradas
- Reinicia el servidor de desarrollo

### Error: "Invalid private key"
- Asegúrate de que la private key incluya los saltos de línea (`\n`)
- En Vercel, copia y pega directamente desde el JSON

### Error: "Permission denied"
- Verifica que el service account tenga permisos en Firebase
- Ve a Firebase Console → IAM & Admin → verifica el rol
