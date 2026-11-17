
const MODEL = "gemini-3.8-flash";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        status: "online",
        geminiConfigured: Boolean(env.GEMINI_API_KEY)
      });
    }

    if (url.pathname === "/api/solve" && request.method === "POST") {
      try {
        if (!env.GEMINI_API_KEY) {
          return json({
            error: "Chiave Gemini non configurata su Cloudflare."
          }, 500);
        }

        const contentLength = Number(
          request.headers.get("content-length") || 0
        );

        if (contentLength > 15 * 1024 * 1024) {
          return json({
            error: "Le immagini superano il limite di 15 MB."
          }, 413);
        }

        const form = await request.formData();
        const files = form.getAll("images").filter(
          item => item && typeof item.arrayBuffer === "function"
        );

        const mode = String(form.get("mode") || "both");
        const subject = String(form.get("subject") || "Riconoscimento automatico");

        if (files.length === 0) {
          return json({
            error: "Non hai caricato immagini."
          }, 400);
        }

        if (files.length > 30) {
          return json({
            error: "Puoi caricare al massimo 30 immagini."
          }, 400);
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        let totalSize = 0;
        const imageParts = [];

        for (const file of files) {
          if (!allowedTypes.includes(file.type)) {
            return json({
              error: "Formato non supportato. Usa JPG, PNG o WEBP."
            }, 400);
          }

          if (file.size > 5 * 1024 * 1024) {
            return json({
              error: "Una delle immagini supera 5 MB."
            }, 413);
          }

          totalSize += file.size;

          if (totalSize > 15 * 1024 * 1024) {
            return json({
              error: "Il totale delle immagini supera 15 MB."
            }, 413);
          }

          const bytes = new Uint8Array(await file.arrayBuffer());

          imageParts.push({
            inlineData: {
              mimeType: file.type,
              data: toBase64(bytes)
            }
          });
        }

        const prompt = `
Sei RISOLVI QUIZ PROFESSIONAL 2.0, un assistente specializzato
nella risoluzione di quiz universitari italiani.

MATERIE:
- Statistica
- Economia aziendale
- Economia politica
- Teorie e governo dell'impresa
- Diritto d'impresa
- Diritto privato

MATERIA SELEZIONATA: ${subject}
MODALITÀ: ${mode}

ISTRUZIONI:
1. Analizza tutte le immagini caricate.
2. Individua e trascrivi ogni domanda e tutte le alternative visibili.
3. Rispetta la numerazione originale.
4. Seleziona la risposta corretta tra A, B, C e D.
5. In Statistica controlla formule, passaggi e calcoli.
6. In Economia verifica definizioni, teorie e relazioni economiche.
7. In Diritto applica correttamente norme, istituti e definizioni.
8. Non inventare domande, alternative o dati illeggibili.
9. Controlla la coerenza della risposta prima di restituirla.
10. Se non sei sicuro, segnala il dubbio: non inventare una certezza.

Restituisci esclusivamente JSON valido con questa struttura:

{
  "questions": [
    {
      "number": 1,
      "subject": "Statistica",
      "question": "Testo della domanda",
      "answer": "A",
      "confidence": "alta",
      "verification": "Verificata",
      "explanation": "Spiegazione della risposta",
      "calculation": "Formula o calcolo, se necessario",
      "verification_details": "Controllo effettuato",
      "warning": ""
    }
  ]
}

Se la modalità è exam, mantieni le risposte concise.
Se un'immagine è illeggibile, segnala il problema nel campo warning.
Non aggiungere testo fuori dal JSON.
`;

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [
                  { text: prompt },
                  ...imageParts
                ]
              }],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.1
              }
            }),
            signal: AbortSignal.timeout(90000)
          }
        );

        const result = await response.json();

        if (!response.ok) {
          return json({
            error: "Errore durante la comunicazione con Gemini.",
            details: result.error?.message || "Servizio AI non disponibile."
          }, 502);
        }

        const output = result.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("");

        if (!output) {
          return json({
            error: "Gemini non ha restituito una risposta leggibile."
          }, 502);
        }

        let parsed;

        try {
          parsed = JSON.parse(output);
        } catch {
          return json({
            error: "La risposta AI non è in un formato valido."
          }, 502);
        }

        if (!Array.isArray(parsed.questions)) {
          return json({
            error: "Non è stato possibile individuare le domande."
          }, 502);
        }

        return json({
          success: true,
          questions: parsed.questions
        });

      } catch (error) {
        return json({
          error: error.name === "TimeoutError"
            ? "Analisi troppo lunga. Riprova con meno immagini."
            : "Errore durante l'analisi delle immagini.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Endpoint non trovato." }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Sito non disponibile.", { status: 404 });
  }
};
