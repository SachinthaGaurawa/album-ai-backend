// api/img.js – Generates an image based on a prompt and returns it (by URL or directly as binary).
import { createDeepInfra, deepinfra } from '@ai-sdk/deepinfra';
import { experimental_generateImage as generateImage } from 'ai';
const { put } = require('@vercel/blob');  // Vercel Blob for storing images

const deepinfraProvider = createDeepInfra({
  apiKey: process.env.DEEPINFRA_TOKEN
});
// Choose a Stable Diffusion model from DeepInfra for image generation:
const IMAGE_MODEL_ID = 'stabilityai/sd3.5';  // e.g. Stable Diffusion 3.5 (you can choose other models as needed)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    // The prompt can come via query or JSON body
    const prompt = req.query.prompt || (req.body && req.body.prompt);
    if (!prompt) {
      res.status(400).json({ error: "No prompt provided for image generation." });
      return;
    }
    // Generate the image with the AI SDK
    const result = await generateImage({
      model: deepinfraProvider.image(IMAGE_MODEL_ID),
      prompt,
      // You can include options like size or aspectRatio if supported by the model
      // e.g., aspectRatio: '1:1' for square images.
    });
    const imageData = result.image;  // This is the binary image data (Buffer or Blob)
    // Upload image to Vercel Blob storage for a persistent URL
    const fileName = `gen_${Date.now()}.png`;
    const blob = await put(fileName, imageData, {
      access: 'public',
      contentType: 'image/png',
      // addRandomSuffix: true  // by default, put may add a random suffix if name clashes
    });
    // Respond with the public URL of the image
    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("Image generation error:", err);
    res.status(500).json({ error: "Failed to generate image: " + err.message });
  }
}
