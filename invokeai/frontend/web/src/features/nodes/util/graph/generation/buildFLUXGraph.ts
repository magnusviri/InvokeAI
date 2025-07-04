import { logger } from 'app/logging/logger';
import type { RootState } from 'app/store/store';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { selectMainModelConfig, selectParamsSlice } from 'features/controlLayers/store/paramsSlice';
import { selectRefImagesSlice } from 'features/controlLayers/store/refImagesSlice';
import { selectCanvasMetadata, selectCanvasSlice } from 'features/controlLayers/store/selectors';
import { addFLUXFill } from 'features/nodes/util/graph/generation/addFLUXFill';
import { addFLUXLoRAs } from 'features/nodes/util/graph/generation/addFLUXLoRAs';
import { addFLUXReduxes } from 'features/nodes/util/graph/generation/addFLUXRedux';
import { addImageToImage } from 'features/nodes/util/graph/generation/addImageToImage';
import { addInpaint } from 'features/nodes/util/graph/generation/addInpaint';
import { addNSFWChecker } from 'features/nodes/util/graph/generation/addNSFWChecker';
import { addOutpaint } from 'features/nodes/util/graph/generation/addOutpaint';
import { addRegions } from 'features/nodes/util/graph/generation/addRegions';
import { addTextToImage } from 'features/nodes/util/graph/generation/addTextToImage';
import { addWatermarker } from 'features/nodes/util/graph/generation/addWatermarker';
import { getGenerationMode } from 'features/nodes/util/graph/generation/getGenerationMode';
import { Graph } from 'features/nodes/util/graph/generation/Graph';
import {
  getSizes,
  selectCanvasOutputFields,
  selectPresetModifiedPrompts,
} from 'features/nodes/util/graph/graphBuilderUtils';
import {
  type GraphBuilderReturn,
  type ImageOutputNodes,
  UnsupportedGenerationModeError,
} from 'features/nodes/util/graph/types';
import { selectActiveTab } from 'features/ui/store/uiSelectors';
import { t } from 'i18next';
import type { Invocation } from 'services/api/types';
import type { Equals } from 'tsafe';
import { assert } from 'tsafe';

import { addControlLoRA, addControlNets } from './addControlAdapters';
import { addIPAdapters } from './addIPAdapters';

const log = logger('system');

export const buildFLUXGraph = async (state: RootState, manager: CanvasManager | null): Promise<GraphBuilderReturn> => {
  const tab = selectActiveTab(state);
  const generationMode = await getGenerationMode(manager, tab);
  log.debug({ generationMode }, 'Building FLUX graph');

  const params = selectParamsSlice(state);
  const canvas = selectCanvasSlice(state);
  const refImages = selectRefImagesSlice(state);

  const { bbox } = canvas;

  const { originalSize, scaledSize } = getSizes(bbox);

  const model = selectMainModelConfig(state);

  const {
    guidance: baseGuidance,
    seed,
    steps,
    fluxVAE,
    t5EncoderModel,
    clipEmbedModel,
    img2imgStrength,
    optimizedDenoisingEnabled,
  } = params;

  assert(model, 'No model found in state');
  assert(model.base === 'flux', 'Model is not a FLUX model');
  assert(t5EncoderModel, 'No T5 Encoder model found in state');
  assert(clipEmbedModel, 'No CLIP Embed model found in state');
  assert(fluxVAE, 'No FLUX VAE model found in state');

  const isFLUXFill = model.variant === 'inpaint';
  let guidance = baseGuidance;
  if (isFLUXFill) {
    // FLUX Fill doesn't work with Text to Image or Image to Image generation modes. Well, technically, it does, but
    // the outputs are garbagio.
    //
    // Unfortunately, we do not know the generation mode until the user clicks Invoke, so this is the first place we
    // can check for this incompatibility.
    //
    // We are opting to fail loudly instead of produce garbage images, hence this being an assert.
    //
    // The message in this assert will be shown in a toast to the user, so we are using the translation system for it.
    //
    // The other asserts above are just for sanity & type check and should never be hit, so they do not have
    // translations.
    if (generationMode === 'txt2img' || generationMode === 'img2img') {
      throw new UnsupportedGenerationModeError(t('toast.fluxFillIncompatibleWithT2IAndI2I'));
    }

    // FLUX Fill wants much higher guidance values than normal FLUX - silently "fix" the value for the user.
    // TODO(psyche): Figure out a way to alert the user that this is happening - maybe return warnings from the graph
    // builder and toast them?
    guidance = 30;
  }

  const { positivePrompt } = selectPresetModifiedPrompts(state);

  const g = new Graph(getPrefixedId('flux_graph'));
  const modelLoader = g.addNode({
    type: 'flux_model_loader',
    id: getPrefixedId('flux_model_loader'),
    model,
    t5_encoder_model: t5EncoderModel,
    clip_embed_model: clipEmbedModel,
    vae_model: fluxVAE,
  });

  const posCond = g.addNode({
    type: 'flux_text_encoder',
    id: getPrefixedId('flux_text_encoder'),
    prompt: positivePrompt,
  });
  const posCondCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('pos_cond_collect'),
  });
  const denoise = g.addNode({
    type: 'flux_denoise',
    id: getPrefixedId('flux_denoise'),
    guidance,
    num_steps: steps,
    seed,
    denoising_start: 0,
    denoising_end: 1,
    width: scaledSize.width,
    height: scaledSize.height,
  });

  const l2i = g.addNode({
    type: 'flux_vae_decode',
    id: getPrefixedId('flux_vae_decode'),
  });

  g.addEdge(modelLoader, 'transformer', denoise, 'transformer');
  g.addEdge(modelLoader, 'vae', denoise, 'controlnet_vae');
  g.addEdge(modelLoader, 'vae', l2i, 'vae');

  g.addEdge(modelLoader, 'clip', posCond, 'clip');
  g.addEdge(modelLoader, 't5_encoder', posCond, 't5_encoder');
  g.addEdge(modelLoader, 'max_seq_len', posCond, 't5_max_seq_len');
  g.addEdge(posCond, 'conditioning', posCondCollect, 'item');
  g.addEdge(posCondCollect, 'collection', denoise, 'positive_text_conditioning');
  g.addEdge(denoise, 'latents', l2i, 'latents');

  addFLUXLoRAs(state, g, denoise, modelLoader, posCond);

  g.upsertMetadata({
    guidance,
    width: originalSize.width,
    height: originalSize.height,
    positive_prompt: positivePrompt,
    model: Graph.getModelMetadataField(model),
    seed,
    steps,
    vae: fluxVAE,
    t5_encoder: t5EncoderModel,
    clip_embed_model: clipEmbedModel,
  });

  let denoising_start: number;
  if (optimizedDenoisingEnabled) {
    // We rescale the img2imgStrength (with exponent 0.2) to effectively use the entire range [0, 1] and make the scale
    // more user-friendly for FLUX. Without this, most of the 'change' is concentrated in the high denoise strength
    // range (>0.9).
    denoising_start = 1 - img2imgStrength ** 0.2;
  } else {
    denoising_start = 1 - img2imgStrength;
  }

  let canvasOutput: Invocation<ImageOutputNodes> = l2i;

  if (isFLUXFill) {
    assert(manager, 'Need manager to do FLUX Fill');
    canvasOutput = await addFLUXFill({
      state,
      g,
      manager,
      l2i,
      denoise,
      originalSize,
      scaledSize,
    });
  } else if (generationMode === 'txt2img') {
    canvasOutput = addTextToImage({ g, l2i, originalSize, scaledSize });
    g.upsertMetadata({ generation_mode: 'flux_txt2img' });
  } else if (generationMode === 'img2img') {
    assert(manager, 'Need manager to do img2img');
    canvasOutput = await addImageToImage({
      g,
      manager,
      l2i,
      i2lNodeType: 'flux_vae_encode',
      denoise,
      vaeSource: modelLoader,
      originalSize,
      scaledSize,
      bbox,
      denoising_start,
      fp32: false,
    });
    g.upsertMetadata({ generation_mode: 'flux_img2img' });
  } else if (generationMode === 'inpaint') {
    assert(manager, 'Need manager to do inpaint');
    canvasOutput = await addInpaint({
      state,
      g,
      manager,
      l2i,
      i2lNodeType: 'flux_vae_encode',
      denoise,
      vaeSource: modelLoader,
      modelLoader,
      originalSize,
      scaledSize,
      denoising_start,
      fp32: false,
      seed,
    });
    g.upsertMetadata({ generation_mode: 'flux_inpaint' });
  } else if (generationMode === 'outpaint') {
    assert(manager, 'Need manager to do outpaint');
    canvasOutput = await addOutpaint({
      state,
      g,
      manager,
      l2i,
      i2lNodeType: 'flux_vae_encode',
      denoise,
      vaeSource: modelLoader,
      modelLoader,
      originalSize,
      scaledSize,
      denoising_start,
      fp32: false,
      seed,
    });
    g.upsertMetadata({ generation_mode: 'flux_outpaint' });
  } else {
    assert<Equals<typeof generationMode, never>>(false);
  }

  if (manager) {
    const controlNetCollector = g.addNode({
      type: 'collect',
      id: getPrefixedId('control_net_collector'),
    });
    const controlNetResult = await addControlNets({
      manager,
      entities: canvas.controlLayers.entities,
      g,
      rect: canvas.bbox.rect,
      collector: controlNetCollector,
      model,
    });
    if (controlNetResult.addedControlNets > 0) {
      g.addEdge(controlNetCollector, 'collection', denoise, 'control');
    } else {
      g.deleteNode(controlNetCollector.id);
    }

    await addControlLoRA({
      manager,
      entities: canvas.controlLayers.entities,
      g,
      rect: canvas.bbox.rect,
      denoise,
      model,
    });
  }

  const ipAdapterCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('ip_adapter_collector'),
  });
  const ipAdapterResult = addIPAdapters({
    entities: refImages.entities,
    g,
    collector: ipAdapterCollect,
    model,
  });

  let totalIPAdaptersAdded = ipAdapterResult.addedIPAdapters;

  const fluxReduxCollect = g.addNode({
    type: 'collect',
    id: getPrefixedId('ip_adapter_collector'),
  });
  const fluxReduxResult = addFLUXReduxes({
    entities: refImages.entities,
    g,
    collector: fluxReduxCollect,
    model,
  });
  let totalReduxesAdded = fluxReduxResult.addedFLUXReduxes;

  if (manager) {
    const regionsResult = await addRegions({
      manager,
      regions: canvas.regionalGuidance.entities,
      g,
      bbox: canvas.bbox.rect,
      model,
      posCond,
      negCond: null,
      posCondCollect,
      negCondCollect: null,
      ipAdapterCollect,
      fluxReduxCollect,
    });

    totalIPAdaptersAdded += regionsResult.reduce((acc, r) => acc + r.addedIPAdapters, 0);
    totalReduxesAdded += regionsResult.reduce((acc, r) => acc + r.addedFLUXReduxes, 0);
  }

  if (totalIPAdaptersAdded > 0) {
    g.addEdge(ipAdapterCollect, 'collection', denoise, 'ip_adapter');
  } else {
    g.deleteNode(ipAdapterCollect.id);
  }

  if (totalReduxesAdded > 0) {
    g.addEdge(fluxReduxCollect, 'collection', denoise, 'redux_conditioning');
  } else {
    g.deleteNode(fluxReduxCollect.id);
  }

  // TODO: Add FLUX Reduxes to denoise node like we do for ipa

  if (state.system.shouldUseNSFWChecker) {
    canvasOutput = addNSFWChecker(g, canvasOutput);
  }

  if (state.system.shouldUseWatermarker) {
    canvasOutput = addWatermarker(g, canvasOutput);
  }

  g.upsertMetadata(selectCanvasMetadata(state));

  g.updateNode(canvasOutput, selectCanvasOutputFields(state));

  g.setMetadataReceivingNode(canvasOutput);
  return {
    g,
    seedFieldIdentifier: { nodeId: denoise.id, fieldName: 'seed' },
    positivePromptFieldIdentifier: { nodeId: posCond.id, fieldName: 'prompt' },
  };
};
