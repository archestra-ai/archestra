// There is an issue with the OpenAPI type generation with libpod swagger mixing type of Docker and PodmanAPI specs
// Specifically, the `Mount` type uses `Target` for Docker and `Destination` for Podman, but not both
// This file provides utility functions to convert between the two types
// See https://github.com/archestra-ai/archestra/pull/338#issuecomment-3278579082
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin vers vos types générés (ajustez selon votre structure)
const typesFilePath = path.join(__dirname, '../../src/backend/clients/libpod/gen/types.gen.ts');
function fixMountTypes() {
  console.log('🔧 Correction du fichier types.gen.ts...');

  if (!fs.existsSync(typesFilePath)) {
    console.error(`❌ Le fichier ${typesFilePath} n'existe pas`);
    console.log('Chemin recherché:', typesFilePath);
    return;
  }

  try {
    let content = fs.readFileSync(typesFilePath, 'utf8');
    let modified = false;

    // Chercher et remplacer Target par Destination dans le type Mount
    const originalContent = content;

    // Pattern spécifique pour le type Mount
    // Ajoute "Destination?: string;" après "Target?: string;" dans la définition du type Mount
    content = content.replace(
      /(export\s+type\s+Mount\s*=\s*{[^}]*?Target\?\s*:\s*string;)/gs,
      '$1\n  Destination?: string; // add missing type replacing Target for podman API compatibility'
    );

    // Vérifier si une modification a été effectuée
    if (content !== originalContent) {
      modified = true;

      fs.writeFileSync(typesFilePath, content);
      console.log('✅ types.gen.ts corrigé avec succès');
      console.log('   Mount.Target → Mount.Destination');
    } else {
      console.log('ℹ️  Aucune modification nécessaire (Target non trouvé ou déjà corrigé)');
    }
  } catch (error) {
    console.error(`❌ Erreur lors de la modification:`, error.message);
  }
}

// Exécution
fixMountTypes();
console.log('✨ Correction terminée !');
