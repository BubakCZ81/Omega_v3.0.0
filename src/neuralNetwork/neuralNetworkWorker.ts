export {};

type Sample = { features: number[]; label: 0 | 1 };
type TrainRequest = { type: 'train'; samples: Sample[]; epochs: number };
type WorkerMessage = { type: 'start' } | { type: 'cancel' } | { type: 'dispose' } | TrainRequest;

let disposed = false;
let cancelled = false;

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const random = () => (Math.random() - 0.5) * 0.16;
const yieldToMessages = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function validateSamples(samples: Sample[]): number {
  const width = samples[0]?.features.length ?? 0;
  if (samples.length < 100 || width < 1 || samples.some(sample => sample.features.length !== width || !sample.features.every(Number.isFinite))) {
    throw new Error('Need at least 100 settled signals with complete numeric features.');
  }
  return width;
}

async function train(samples: Sample[], epochs: number): Promise<void> {
  const inputSize = validateSamples(samples);
  const split = Math.max(1, Math.floor(samples.length * 0.8));
  const trainSamples = samples.slice(0, split);
  const validation = samples.slice(split);
  const means = Array.from({ length: inputSize }, (_, index) => trainSamples.reduce((sum, sample) => sum + sample.features[index], 0) / trainSamples.length);
  const scales = Array.from({ length: inputSize }, (_, index) => Math.max(1e-8, Math.sqrt(trainSamples.reduce((sum, sample) => sum + (sample.features[index] - means[index]) ** 2, 0) / trainSamples.length)));
  const normalize = (features: number[]) => features.map((value, index) => (value - means[index]) / scales[index]);
  const hiddenSize = Math.min(12, Math.max(4, Math.ceil(inputSize * 1.5)));
  const hiddenWeights = Array.from({ length: hiddenSize }, () => Array.from({ length: inputSize }, random));
  const hiddenBias = Array.from({ length: hiddenSize }, random);
  const outputWeights = Array.from({ length: hiddenSize }, random);
  let outputBias = random();
  const totalEpochs = Math.max(5, Math.min(120, Math.round(epochs)));
  const rate = 0.012;

  for (let epoch = 1; epoch <= totalEpochs; epoch += 1) {
    if (cancelled || disposed) return;
    let loss = 0;
    for (const sample of trainSamples) {
      const input = normalize(sample.features);
      const hiddenRaw = hiddenWeights.map((weights, row) => hiddenBias[row] + weights.reduce((sum, weight, column) => sum + weight * input[column], 0));
      const hidden = hiddenRaw.map(value => Math.max(0, value));
      const output = sigmoid(outputBias + outputWeights.reduce((sum, weight, index) => sum + weight * hidden[index], 0));
      loss += -(sample.label * Math.log(Math.max(output, 1e-8)) + (1 - sample.label) * Math.log(Math.max(1 - output, 1e-8)));
      const delta = output - sample.label;
      for (let row = 0; row < hiddenSize; row += 1) {
        const hiddenDelta = hiddenRaw[row] > 0 ? delta * outputWeights[row] : 0;
        outputWeights[row] -= rate * delta * hidden[row];
        hiddenBias[row] -= rate * hiddenDelta;
        for (let column = 0; column < inputSize; column += 1) hiddenWeights[row][column] -= rate * hiddenDelta * input[column];
      }
      outputBias -= rate * delta;
    }
    const correct = validation.reduce((count, sample) => {
      const input = normalize(sample.features);
      const hidden = hiddenWeights.map((weights, row) => Math.max(0, hiddenBias[row] + weights.reduce((sum, weight, column) => sum + weight * input[column], 0)));
      const score = sigmoid(outputBias + outputWeights.reduce((sum, weight, index) => sum + weight * hidden[index], 0));
      return count + (Number(score >= 0.5) === sample.label ? 1 : 0);
    }, 0);
    self.postMessage({ type: 'progress', epoch, epochs: totalEpochs, loss: loss / trainSamples.length, validationAccuracy: validation.length ? correct / validation.length : 0 });
    await yieldToMessages();
  }
  if (cancelled || disposed) return;
  self.postMessage({ type: 'trained', metrics: { trainSamples: trainSamples.length, validationSamples: validation.length }, model: { version: 1, inputSize, hiddenSize, means, scales, hiddenWeights, hiddenBias, outputWeights, outputBias } });
}

self.addEventListener('message', event => {
  const message = event.data as WorkerMessage;
  if (message.type === 'start') self.postMessage({ type: 'ready', memory: 'Waiting for settled Pine signals' });
  else if (message.type === 'cancel') { cancelled = true; self.postMessage({ type: 'cancelled' }); }
  else if (message.type === 'train') { cancelled = false; void train(message.samples, message.epochs).catch(error => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Training failed.' })); }
  else if (message.type === 'dispose') { disposed = true; self.postMessage({ type: 'disposed', released: true }); self.close(); }
});
