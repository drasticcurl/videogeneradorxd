/**
 * Generador del PlanJSON del VSL "Agua de Arroz TURBO" (Lic. Natalia Reyes + testimonio Romina).
 *
 * Fuente: vsl avatar MD (91 fragmentos de Natalia + 4 de Romina) + guion adaptado.
 * - 2 avatares de referencia (fotos subidas): natalia, romina  -> identidad fija.
 * - Planos de Natalia: medium close-up + primer plano (image2image contra su foto).
 * - B-ROLL: insertos text2image, el clip lleva la voz en off (no hay cara hablando).
 *
 * Uso:  npx tsx scripts/generate-vsl-plan.ts
 * Salida: vsl-natalia-plan.json (validado contra el schema Zod del proyecto).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlan, type ProjectPlan } from "../src/lib/schema";

const NEG =
  "beauty filter, plastic skin, over-smoothing, extra fingers, distorted hands, warped mouth, changing face between shots, text captions, watermark, cartoon, oversaturated, low quality";

/* --------- B-ROLL: id -> prompt (en ingles, vertical 9:16) --------- */
const BROLL: Record<string, string> = {
  espejo:
    "A woman looking at herself in a mirror, happy and proud, bright modern bedroom, soft natural light, photorealistic, vertical 9:16.",
  vestido_percha:
    "An elegant dress hanging on a clothing rack in a bright boutique, shallow depth of field, photorealistic, vertical 9:16.",
  intestino:
    "Clean stylized 3D medical illustration of a healthy human gut and microbiota, soft glowing bacteria, light background, vertical 9:16.",
  vaso_agua:
    "A glass of rice water on a bright kitchen counter, fresh and clean, condensation, soft daylight, photorealistic, vertical 9:16.",
  reloj:
    "A simple clock on a bright morning kitchen counter, sense of routine and timing, soft daylight, photorealistic, vertical 9:16.",
  ingredientes:
    "Natural anti-inflammatory ingredients arranged on a kitchen counter (lemon, ginger, herbs, rice), bright and fresh, photorealistic, vertical 9:16.",
  app_plan:
    "A smartphone held in hand showing a clean minimal 30-day plan app interface, blurred bright background, no readable text, photorealistic, vertical 9:16.",
  preparacion:
    "Close-up of hands preparing rice water in a bright kitchen, pouring and stirring in a glass, soft daylight, photorealistic, vertical 9:16.",
  calendario:
    "A clean visual 30-day calendar planner with check marks on a bright desk, top-down, photorealistic, vertical 9:16.",
  probandose_ropa:
    "A happy woman trying on clothes at home, clothes fitting well, smiling, bright bedroom, photorealistic, vertical 9:16.",
  piel:
    "Beauty close-up of a woman's clear, luminous, healthy skin and face, soft natural light, realistic skin texture, photorealistic, vertical 9:16.",
  precio_estetica:
    "A modern aesthetic clinic treatment room, premium look, soft light, photorealistic, vertical 9:16.",
  precio_gym:
    "A modern gym interior with treadmills and weights, bright, photorealistic, vertical 9:16.",
  precio_nutri:
    "A nutritionist consultation office with a desk and healthy food charts, bright and professional, photorealistic, vertical 9:16.",
  precio_tachado:
    "A price tag showing a number crossed out with a red strike-through line, clean studio background, photorealistic, vertical 9:16.",
  bono1:
    "A clean digital product cover mockup for a bonus guide (ebook on a tablet), premium minimal design, no readable text, vertical 9:16.",
  bono2:
    "A clean digital product cover mockup for a beauty rituals bonus guide on a tablet, premium minimal design, no readable text, vertical 9:16.",
  bono3:
    "A clean digital product cover mockup for a mindfulness program bonus on a tablet, calm premium design, no readable text, vertical 9:16.",
  bonos_stack:
    "Three digital product cover mockups stacked together on a soft gradient background, premium look, no readable text, vertical 9:16.",
  ropa_suelta:
    "A woman wearing looser, comfortable clothes that now fit better, happy and relaxed at home, photorealistic, vertical 9:16.",
  mercadopago:
    "A smartphone showing a generic secure online payment screen in hand, blurred background, no readable text or logos, photorealistic, vertical 9:16.",
};

/* --------- Fragmentos de Natalia (1..91): [dialogo, visual, brollKey|null] --------- */
const N: Array<[string, string, string | null]> = [
  [`Hola, soy la licenciada Natalia Reyes. Estás en el lugar correcto.`, `Primer plano, sonrisa cálida`, null],
  [`Por favor, no hagas clic en atrás ni cierres esta página: podrías generar errores en tu compra.`, `Gesto de "pará" suave con la mano`, null],
  [`Y perder el acceso que acabás de conseguir. Quiero felicitarte.`, `Plano medio`, null],
  [`Tomaste una de las mejores decisiones de tu vida al elegir el Método del Agua de Arroz.`, `Asiente, confiada`, null],
  [`Para deshinchar tu panza, sentirte liviana y recuperar la confianza en tu cuerpo.`, `Sonríe`, null],
  [`Hoy es el primer día de tu nueva vida. Acá es donde todo empieza.`, `Mira fijo a cámara`, null],
  [`Ahora descubriste el poder del agua de arroz para calmar tu intestino.`, `Plano medio`, null],
  [`Alimentar tus bacterias buenas, cortar la ansiedad por la comida y desinflamarte de forma natural.`, `Cuenta con los dedos`, null],
  [`Y lo mejor: sin dejar de comer lo que te gusta y sin matarte en el gimnasio.`, `Niega con la cabeza, sonríe`, null],
  [`Todos los días recibo mensajes de mujeres como vos logrando deshinchar la panza.`, `Cálida`, null],
  [`Sentirse livianas y volver a mirarse al espejo con orgullo.`, `(B-ROLL) mujer mirándose al espejo, contenta`, "espejo"],
  [`Y creo que dentro de muy poquito voy a recibir tu testimonio también.`, `Sonríe a cámara`, null],
  [`Pero para que esto pase, necesitás tomar el agua de arroz todos los días, como te explico. ¿De acuerdo?`, `Tono firme, cercano`, null],
  [`Tené en cuenta algo importante: cada cuerpo es distinto.`, `Plano medio`, null],
  [`Tu edad, tu peso, tu altura, tus embarazos… todo cambia cómo responde tu cuerpo.`, `Gesto enumerando`, null],
  [`Pensalo así: es como buscar el vestido perfecto para una fiesta.`, `(B-ROLL) vestido en perchero`, "vestido_percha"],
  [`Si comprás uno ya hecho, capaz te queda bien. Pero a medida, te queda muchísimo mejor.`, `Sonríe`, null],
  [`Con el agua de arroz pasa lo mismo. Por tu cuenta vas a tener buenos resultados.`, `Asiente`, null],
  [`Pero después de los 35 o 40 se vuelve más difícil, por los cambios hormonales.`, `Tono empático`, null],
  [`La retención de líquidos y un metabolismo que se vuelve lento como una tortuga.`, `Gesto lento con la mano`, null],
  [`Por eso, si querés resultados rápidos y sostenidos, lo mejor es un protocolo acelerado a tu medida.`, `Confiada`, null],
  [`Por eso creamos algo completamente distinto. Lo llamamos Protocolo Agua de Arroz TURBO.`, `Énfasis en el nombre`, null],
  [`Y te voy a ser sincera: es el mismo que muchas alumnas usaron como prueba interna.`, `Tono confidencial`, null],
  [`Y los resultados fueron tan rápidos que nos sorprendieron a nosotras mismas.`, `Ojos abiertos`, null],
  [`Porque activa lo que llamamos la fase turbo del intestino.`, `(B-ROLL) animación de intestino/microbiota`, "intestino"],
  [`Una etapa donde tu cuerpo desinflama y suelta líquidos y grasa mucho más rápido.`, `Plano medio`, null],
  [`¿Cómo? Combinando tres ajustes que casi nadie aplica bien.`, `Muestra tres dedos`, null],
  [`Uno: la concentración exacta de almidón resistente para reactivar tu metabolismo.`, `(B-ROLL) vaso de agua de arroz`, "vaso_agua"],
  [`Dos: el horario estratégico, en ayunas y antes de cenar, para maximizar el deshinchado.`, `(B-ROLL) reloj / mañana`, "reloj"],
  [`Y tres: los ingredientes potenciadores que la convierten en una bomba antiinflamatoria natural.`, `(B-ROLL) ingredientes en mesada`, "ingredientes"],
  [`El resultado: mujeres que ven resultados hasta tres veces más rápido que con el agua de arroz sola.`, `Confiada, asiente`, null],
  [`Y lo mejor es que no es nada complicado. Está pensado para que cualquier mujer lo siga fácil.`, `Sonríe`, null],
  [`Cuando entres, vas a recibir el protocolo completo de 30 días que activa el modo turbo.`, `(B-ROLL) app / pantalla del plan`, "app_plan"],
  [`Una guía paso a paso para preparar la versión turbo del agua de arroz con los potenciadores.`, `(B-ROLL) preparación`, "preparacion"],
  [`Qué pequeños cambios de horario hacer para acelerar tu metabolismo al máximo.`, `Plano medio`, null],
  [`Y qué errores evitar para entrar en modo deshinchado mucho más rápido.`, `Tono de consejo`, null],
  [`Más un calendario visual de 30 días: solo seguís el día que toca, sin pensar.`, `(B-ROLL) calendario 30 días`, "calendario"],
  [`Mirás el día, seguís la indicación, cinco minutos por día, y tu cuerpo hace el resto.`, `Muestra 5 dedos`, null],
  [`Sin contar calorías, sin gimnasio, sin dejar de comer lo que te gusta.`, `Niega, sonríe`, null],
  [`Muchas mujeres me dicen que es lo más fácil que probaron en su vida.`, `Cálida`, null],
  [`Imaginate cómo te vas a sentir en tres o cuatro semanas.`, `Mira a lo lejos, soñadora`, null],
  [`Tu ropa favorita volviendo a quedarte bien y más energía durante el día.`, `(B-ROLL) mujer probándose ropa, contenta`, "probandose_ropa"],
  [`Esa sensación de mirarte al espejo y sentir orgullo otra vez.`, `(B-ROLL) espejo`, "espejo"],
  [`Energía para tus hijos, para tu día, para vos. Vas a volver a sentirte vos misma.`, `Emotiva, sonríe`, null],
  [`Pero hay algo importante que tenés que saber.`, `Tono serio`, null],
  [`El Protocolo TURBO normalmente no se ofrece al público.`, `Plano medio`, null],
  [`Se creó como un método interno para acelerar a las alumnas que ya aplicaban el método.`, `Confidencial`, null],
  [`Hoy decidimos abrirlo solo para quienes acaban de entrar, como vos.`, `Señala a cámara`, null],
  [`Por eso limitamos los cupos a 25, y ahora mismo quedan 9.`, `Énfasis en el número`, null],
  [`Si querés deshincharte con el mínimo esfuerzo, asegurá tu lugar antes de que se agoten.`, `Tono de urgencia amable`, null],
  [`Y recordá: esto va mucho más allá de la panza.`, `Plano medio`, null],
  [`Te ayuda a reducir la hinchazón y la retención de líquidos.`, `Cuenta con los dedos`, null],
  [`A cortar la ansiedad por lo dulce a la noche y a mejorar tu digestión.`, `Sigue contando`, null],
  [`A dormir mejor y a tener la piel más limpia al desinflamar el intestino.`, `(B-ROLL) piel/rostro luminoso`, "piel"],
  [`Y a sacarte esa pesadez y esa sensación de globo que te acompaña todo el día.`, `Gesto de alivio`, null],
  [`Al final vas a tener todo el conocimiento para mantenerte así, sin efecto rebote.`, `Confiada`, null],
  [`Pero recordá: solo quedan 9 cupos. Cuando se cierre esta página, no vuelve.`, `Tono firme`, null],
  [`Ahora quiero que lo pienses bien. ¿Cuánto vale todo esto?`, `Mira a cámara`, null],
  [`¿Cuánto vas a ahorrar en gimnasios, dietas locas y tratamientos peligrosos?`, `Plano medio`, null],
  [`Un tratamiento estético para la retención arranca en cientos de miles de pesos.`, `(B-ROLL) texto/precio en pantalla`, "precio_estetica"],
  [`Un año de gimnasio te sale, mínimo, cuatrocientos mil pesos.`, `(B-ROLL) precio`, "precio_gym"],
  [`Y tres consultas con un nutricionista te salen en promedio trescientos mil.`, `(B-ROLL) precio`, "precio_nutri"],
  [`Por eso, un precio justo para el Protocolo TURBO sería treinta y nueve mil novecientos noventa.`, `(B-ROLL) $39.990 tachado`, "precio_tachado"],
  [`Y ya es muchísimo más barato que cualquiera de esas opciones, ¿no?`, `Asiente`, null],
  [`Pero voy a hacer una excepción. Y no es por la plata.`, `Tono honesto`, null],
  [`Es porque sé lo que es vivir hinchada, incómoda con tu cuerpo y con las miradas. Yo pasé por eso.`, `Empática, cercana`, null],
  [`Y hay más. Si asegurás tu lugar en los próximos minutos, te sumo tres regalos.`, `Sonríe, muestra 3 dedos`, null],
  [`Regalo uno: los ingredientes potenciadores secretos para multiplicar el efecto del agua de arroz.`, `(B-ROLL) mockup bono 1`, "bono1"],
  [`El ingrediente dorado de la mañana, el tónico para la ansiedad nocturna y el batido desinflamante.`, `(B-ROLL) ingredientes`, "ingredientes"],
  [`Regalo dos: los rituales de las famosas para cuidar el cuerpo y la piel después de los 40.`, `(B-ROLL) mockup bono 2`, "bono2"],
  [`Regalo tres: el programa Mente y Panza, para bajar la ansiedad y el estrés que inflaman el intestino.`, `(B-ROLL) mockup bono 3`, "bono3"],
  [`Son casi veinticinco mil pesos en regalos, totalmente gratis.`, `(B-ROLL) stack de bonos`, "bonos_stack"],
  [`Pero te lo voy a poner aún más fácil, porque estás protegida por mi garantía de 30 días.`, `Plano medio · acá se activa el bloque de pago abajo`, null],
  [`Así no tenés ni que decir que sí ahora. Solo tenés que decir "tal vez".`, `Sonríe`, null],
  [`Probá el protocolo, aplicalo unos días y sentí cómo tu cuerpo responde.`, `Cálida`, null],
  [`La hinchazón baja, la ansiedad se calma, la ropa empieza a quedarte más suelta.`, `(B-ROLL) ropa más suelta`, "ropa_suelta"],
  [`Si no estás conforme, pedís el reembolso por Mercado Pago y te devolvemos cada peso.`, `(B-ROLL) logo Mercado Pago`, "mercadopago"],
  [`Sin preguntas. Y los regalos te los quedás igual.`, `Asiente, sonríe`, null],
  [`¿Y sabés por qué hago esto? Porque estoy segura de que funciona.`, `Confiada`, null],
  [`Mirá lo que me contó Romina, desde Buenos Aires.`, `Transición a testimonio`, null],
  [`Y como Romina hay muchísimas. Todos los días recibo mensajes así.`, `Vuelve a Natalia`, null],
  [`Y creo que el próximo va a ser el tuyo.`, `Sonríe a cámara`, null],
  [`Así que no pierdas tiempo. Tocá el botón de acá abajo.`, `Señala hacia abajo`, null],
  [`Y comprobá si todavía quedan cupos para el Protocolo Agua de Arroz TURBO.`, `Plano medio`, null],
  [`Estás a un solo clic de resolver tu insatisfacción con tu panza, tu energía y tu digestión.`, `Cálida`, null],
  [`Imaginate un protocolo simple, claro y a tu medida, para activar la fase turbo del intestino.`, `(B-ROLL) app`, "app_plan"],
  [`Y recordá: si asegurás tu lugar ahora, te llevás los tres regalos gratis.`, `Muestra 3 dedos`, null],
  [`Y estás protegida por la garantía de 30 días. No corrés ningún riesgo.`, `Asiente`, null],
  [`Probás, y solo después decidís si te lo quedás.`, `Sonríe`, null],
  [`La decisión es tuya. Tocá el botón de abajo y asegurá tu lugar.`, `Señala hacia abajo`, null],
  [`Estoy deseando conocer tu historia de éxito.`, `Sonríe, despedida cálida`, null],
];

/* Testimonios de Romina (van entre el fragmento 80 y el 81). */
const ROMINA: string[] = [
  `Hola Naty. No pensé que iba a funcionar tan rápido.`,
  `Yo ya tomaba el agua de arroz, pero sentía que estaba estancada.`,
  `Con el protocolo turbo me di cuenta de que cometía errores: la cantidad, el horario, los ingredientes.`,
  `En unas semanas se me desinfló la panza y la ansiedad de la noche desapareció. Me cambió la forma de cuidarme.`,
];

/* --------- helpers --------- */
const ACTIONS: Array<[string, string]> = [
  ["despedida", "smiling warmly as a heartfelt goodbye"],
  ["pará", "raising one hand in a gentle 'stop' gesture"],
  ["enumerando", "counting items on her fingers"],
  ["cuenta con los dedos", "counting points on her fingers"],
  ["sigue contando", "continuing to count on her fingers"],
  ["tres dedos", "holding up three fingers"],
  ["3 dedos", "holding up three fingers"],
  ["5 dedos", "holding up five fingers"],
  ["señala hacia abajo", "pointing downward toward the button below"],
  ["señala a cámara", "pointing toward the camera"],
  ["señala", "pointing toward the camera"],
  ["mira fijo", "looking straight into the camera, sincere"],
  ["sonríe a cámara", "smiling warmly at the camera"],
  ["mira a lo lejos", "gazing into the distance, dreamy and hopeful"],
  ["soñadora", "with a dreamy, hopeful expression"],
  ["mira a cámara", "looking directly at the camera"],
  ["gesto lento", "moving her hand slowly, like a slow tortoise"],
  ["gesto de alivio", "with a gesture of relief, a soft exhale"],
  ["ojos abiertos", "eyes widening with genuine surprise"],
  ["confidencial", "leaning in slightly, confidential tone"],
  ["énfasis", "speaking with emphasis, confident"],
  ["asiente", "nodding confidently"],
  ["niega", "gently shaking her head while smiling"],
  ["empática", "with an empathetic, caring expression"],
  ["emotiva", "with an emotional, heartfelt expression"],
  ["tono serio", "with a serious, measured expression"],
  ["tono firme", "with a firm, reassuring tone"],
  ["firme", "with a firm, warm tone"],
  ["urgencia", "with kind, gentle urgency"],
  ["honesto", "with an honest, sincere expression"],
  ["consejo", "in a friendly advising tone"],
  ["transición", "smiling, transitioning to a customer testimonial"],
  ["vuelve a natalia", "warm, talking directly to camera"],
  ["confiada", "looking confident and reassuring"],
  ["sonrisa cálida", "with a warm, friendly smile"],
  ["cálida", "with a warm, caring smile"],
  ["sonríe", "smiling warmly"],
];

const GESTURE_KEYS = [
  "pará", "dedos", "enumerando", "señala", "asiente", "niega", "muestra",
  "gesto", "cuenta", "contando", "alivio",
];
const CLOSEUP_KEYS = [
  "primer plano", "mira fijo", "sonríe a cámara", "mira a cámara", "despedida",
  "emotiva", "empática", "soñadora", "mira a lo lejos", "honesto",
];

function actionFromVisual(visual: string): string {
  const v = visual.toLowerCase();
  for (const [k, a] of ACTIONS) if (v.includes(k)) return a;
  return "talking directly to camera with a natural, warm expression";
}
function frameFor(visual: string): "natalia_medium" | "natalia_closeup" {
  const v = visual.toLowerCase();
  if (GESTURE_KEYS.some((k) => v.includes(k))) return "natalia_medium";
  if (CLOSEUP_KEYS.some((k) => v.includes(k))) return "natalia_closeup";
  return "natalia_medium";
}
function durFor(dialogo: string): number {
  return dialogo.trim().split(/\s+/).length <= 11 ? 6 : 8;
}
function talkingHeadPrompt(action: string): string {
  return (
    `Animate the avatar into a realistic talking-head video. The same Argentine nutritionist ` +
    `(35-42) talks directly to camera, ${action}. Bright modern nutrition office, light/beige blouse, ` +
    `keep the exact same face, wardrobe, hairstyle and set as the reference, subtle natural head and hand ` +
    `movements, realistic skin texture, accurate lip-sync to the Spanish audio. Vertical 9:16.`
  );
}
function brollVideoPrompt(brollPrompt: string): string {
  return (
    `B-roll insert, no person and no talking face on screen. ${brollPrompt} Gentle slow camera movement, ` +
    `soft natural light, photorealistic. The Spanish line plays as voiceover narration over the insert. Vertical 9:16.`
  );
}
function rominaVideoPrompt(action: string): string {
  return (
    `Animate the avatar into a realistic talking-head testimonial video. The same everyday Argentine woman ` +
    `(a real customer, NOT the nutritionist) talks directly to camera, ${action}. Cozy home living-room setting, ` +
    `casual light top, keep the exact same face, hair and look as the reference image, subtle natural head and ` +
    `hand movements, realistic skin texture, accurate lip-sync to the Spanish audio. Vertical 9:16.`
  );
}

/* --------- build assets --------- */
const natalia = {
  id: "natalia",
  tipo: "avatar" as const,
  images: [
    {
      id: "natalia_medium",
      modo: "image2image" as const,
      ref_image_id: "natalia",
      prompt:
        "Medium close-up portrait of the SAME woman as the reference photo. Keep identity 100% consistent with " +
        "the reference, same face, same eyes, same nose, same mouth, same skin tone, same dark hair, clearly the " +
        "same recognizable person. Argentine nutritionist 35-42, warm and trustworthy, light/beige blouse, seated " +
        "talking to camera in a bright modern nutrition office with a softly blurred background (plants, wooden " +
        "shelf, neutral tones). Soft natural daylight, shallow depth of field, realistic skin texture, " +
        "photorealistic, friendly confident expression. Vertical 9:16.",
      negative_prompt: NEG,
    },
    {
      id: "natalia_closeup",
      modo: "image2image" as const,
      ref_image_id: "natalia_medium",
      prompt:
        "Tighter close-up of the SAME woman, keep identity 100% consistent with the reference, same face, same " +
        "person, same hairstyle and the same light/beige blouse, same bright nutrition office set, warm confident " +
        "expression, soft natural daylight, realistic skin texture, photorealistic. Vertical 9:16.",
      negative_prompt: NEG,
    },
  ],
};

// Romina (testimonio) NO tiene foto real: se INVENTA de cero con text2image.
// Su imagen base es la fuente de identidad de sus 4 clips (misma cara siempre).
const romina = {
  id: "romina",
  tipo: "avatar" as const,
  images: [
    {
      id: "romina_medium",
      modo: "text2image" as const,
      prompt:
        "Studio-quality medium close-up portrait of an invented everyday Argentine woman, 30-45 years old, a " +
        "real-looking customer (not a model). She must look clearly DIFFERENT from the nutritionist: different face, " +
        "different hair color and style, different features. Natural and genuine, friendly grateful expression, " +
        "casual light top, seated talking to camera at home with a softly blurred cozy living-room background " +
        "(warm neutral tones, a plant). Soft natural daylight, shallow depth of field, realistic skin texture, " +
        "photorealistic. Vertical 9:16.",
      negative_prompt: NEG,
    },
  ],
};

const broll = {
  id: "broll",
  tipo: "broll" as const,
  images: Object.entries(BROLL).map(([id, prompt]) => ({
    id,
    modo: "text2image" as const,
    prompt,
    negative_prompt: NEG,
  })),
};

/* --------- build clips (orden secuencial) --------- */
type Clip = ProjectPlan["clips"][number];
const clips: Clip[] = [];
let orden = 1;

function pushNatalia(n: number) {
  const [dialogo, visual, brollKey] = N[n - 1];
  if (brollKey) {
    clips.push({
      id: `c${n}`,
      orden: orden++,
      asset_id: "broll",
      image_id: brollKey,
      video_prompt: brollVideoPrompt(BROLL[brollKey]),
      dialogo,
      duracion_seg: durFor(dialogo),
      etiqueta: "IA",
      on_screen_text: "",
    });
  } else {
    clips.push({
      id: `c${n}`,
      orden: orden++,
      asset_id: "natalia",
      image_id: frameFor(visual),
      video_prompt: talkingHeadPrompt(actionFromVisual(visual)),
      dialogo,
      duracion_seg: durFor(dialogo),
      etiqueta: "IA",
      on_screen_text: "",
    });
  }
}

// 1..80
for (let n = 1; n <= 80; n++) pushNatalia(n);
// Testimonios Romina T1..T4
ROMINA.forEach((dialogo, i) => {
  clips.push({
    id: `t${i + 1}`,
    orden: orden++,
    asset_id: "romina",
    image_id: "romina_medium",
    video_prompt: rominaVideoPrompt(
      i === ROMINA.length - 1
        ? "happy and relieved, giving a heartfelt testimonial to camera"
        : "giving a sincere, genuine testimonial to camera"
    ),
    dialogo,
    duracion_seg: durFor(dialogo),
    etiqueta: "IA",
    on_screen_text: "",
  });
});
// 81..91
for (let n = 81; n <= 91; n++) pushNatalia(n);

/* --------- assemble plan --------- */
const plan = {
  global: {
    idioma_dialogo: "es-AR",
    formato: "9:16",
    reglas_realismo:
      "Talking head profesional pero cercano: nutricionista argentina 35-42, MISMA cara/peinado/ropa (blusa clara) " +
      "y mismo set (consultorio luminoso, fondo desenfocado con plantas) en TODOS los clips. Luz natural suave, " +
      "piel con textura real, movimientos naturales de cabeza/manos, lip-sync preciso al audio en espanol. " +
      "Los B-ROLL son insertos sin cara: la voz de Natalia va en off por encima.",
    negative_prompt: NEG,
  },
  references: [{ id: "natalia", label: "Lic. Natalia Reyes" }],
  assets: [natalia, romina, broll],
  clips,
  warnings: [
    "VSL talking-head: subi SOLO la foto real de Natalia como avatar de referencia 'natalia' antes de generar.",
    "Romina (testimonio) NO tiene foto: se genera de cero con IA (text2image) y se mantiene su misma cara en sus 4 clips.",
    "Cada linea del guion = 1 clip (6-8s). Total: 91 de Natalia + 4 de Romina = 95 clips.",
    "Los B-ROLL son clips IA del asset 'broll' (insertos sin cara): Veo genera el inserto + la voz en off; si preferis, en VTURB poneles la voz de Natalia por encima.",
    "El clip c73 es el punto donde, en la pagina /upsell, aparece el bloque de precio/CTA.",
    "Duracion auto: lineas cortas 6s, el resto 8s (unicas duraciones validas de Veo: 4/6/8).",
    "natalia_closeup deriva de natalia_medium (aprobá primero la base). Los demas planos usan medium/closeup segun el encuadre.",
  ],
};

const result = validatePlan(plan);
if (!result.ok) {
  console.error("PLAN INVALIDO:");
  for (const e of result.errors) console.error(` - [${e.path}] ${e.message}`);
  process.exit(1);
}

const out = join(process.cwd(), "vsl-natalia-plan.json");
writeFileSync(out, JSON.stringify(result.plan, null, 2) + "\n", "utf8");
console.log(`OK: plan valido. ${result.plan.clips.length} clips, ` +
  `${result.plan.assets.reduce((a, s) => a + s.images.length, 0)} imagenes, ` +
  `${result.plan.references.length} avatares de referencia.`);
console.log(`Escrito en: ${out}`);
