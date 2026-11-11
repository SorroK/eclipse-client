package com.eclipseclient.hud;

import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.buffers.Std140Builder;
import com.mojang.blaze3d.buffers.Std140SizeCalculator;
import com.mojang.blaze3d.pipeline.RenderPipeline;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.platform.DepthTestFunction;
import com.mojang.blaze3d.systems.CommandEncoder;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.systems.RenderPass;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.textures.FilterMode;
import com.mojang.blaze3d.textures.GpuTexture;
import com.mojang.blaze3d.textures.GpuTextureView;
import com.mojang.blaze3d.textures.TextureFormat;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.VertexFormat;
import net.fabricmc.fabric.api.client.rendering.v1.world.WorldRenderEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MappableRingBuffer;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.resources.Identifier;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix4f;

import java.util.OptionalInt;

/**
 * Velocity-based reprojection motion blur.
 *
 * <p>Every frame the world-render matrices are captured. The blur pass
 * reconstructs each pixel's world position from the depth buffer, reprojects
 * it with the previous frame's matrices and smears along the resulting
 * screen-space velocity. Fast camera turns produce directional streaks while
 * the screen centre and the first-person hand stay sharp.</p>
 *
 * <p>Technique adapted from Smooth Motion Blur by Jahleel
 * (https://github.com/realjahleel/smooth-motion-blur) and Natural Motion Blur
 * by ItsPasi (https://github.com/ItsPasi/natural-motionblur-fabric), both
 * LGPL-3.0-only. See LICENSE-motion-blur.txt in the mod resources.</p>
 *
 * <p>When "include players" is disabled the pass runs after opaque terrain and
 * before entities, so the world blurs while players and other entities are
 * drawn sharp afterwards. When enabled it runs after the world render.</p>
 */
public final class EclipseMotionBlur {
	private static final int MAX_SAMPLES = 100;
	private static final int UBO_SIZE = new Std140SizeCalculator()
		.putMat4f().putMat4f().putMat4f().putMat4f()
		.putVec3().putVec2().putFloat().putInt().putInt().putInt().putInt()
		.get();

	public static final RenderPipeline PIPELINE = RenderPipelines.register(
		RenderPipeline.builder()
			.withLocation(Identifier.fromNamespaceAndPath("eclipse-hud", "pipeline/motion_blur"))
			.withVertexShader("core/screenquad")
			.withFragmentShader(Identifier.fromNamespaceAndPath("eclipse-hud", "post/motion_blur"))
			.withSampler("MainSampler")
			.withSampler("MainDepthSampler")
			.withUniform("MotionBlurUniforms", com.mojang.blaze3d.shaders.UniformType.UNIFORM_BUFFER)
			.withoutBlend()
			.withDepthWrite(false)
			.withDepthTestFunction(DepthTestFunction.NO_DEPTH_TEST)
			.withVertexFormat(DefaultVertexFormat.EMPTY, VertexFormat.Mode.TRIANGLES)
			.build()
	);

	private static final Matrix4f modelView = new Matrix4f();
	private static final Matrix4f projection = new Matrix4f();
	private static final Matrix4f previousModelView = new Matrix4f();
	private static final Matrix4f previousProjection = new Matrix4f();
	private static final Matrix4f modelViewInverse = new Matrix4f();
	private static final Matrix4f projectionInverse = new Matrix4f();

	private static double cameraX, cameraY, cameraZ;
	private static double previousCameraX, previousCameraY, previousCameraZ;
	private static boolean frameCaptured;
	private static boolean previousFrameReady;
	private static boolean blurRan;
	private static boolean loggedFirstPass;

	private static GpuTexture blurTarget;
	private static GpuTextureView blurTargetView;
	private static MappableRingBuffer uniformBuffer;

	private static final boolean VULKANMOD_LOADED =
		FabricLoader.getInstance().isModLoaded("vulkanmod");

	private EclipseMotionBlur() {
	}

	public static void initialize() {
		WorldRenderEvents.BEFORE_ENTITIES.register(context -> {
			if (!EclipseHud.motionBlur() || EclipseHud.motionBlurPlayers()) {
				return;
			}
			blurCurrentFrame(Minecraft.getInstance());
		});
	}

	/** Called from the LevelRenderer mixin at the start of every world render. */
	public static void captureFrame(Matrix4f currentModelView, Matrix4f currentProjection, Vec3 cameraPosition) {
		if (frameCaptured) {
			return;
		}
		modelView.set(currentModelView);
		projection.set(currentProjection);
		cameraX = cameraPosition.x;
		cameraY = cameraPosition.y;
		cameraZ = cameraPosition.z;
		frameCaptured = true;
	}

	/**
	 * Called from the LevelRenderer mixin after the world pass. Commits the
	 * captured matrices for the next frame and applies the players-included
	 * blur when that mode is active.
	 */
	public static void finishFrame(Minecraft client) {
		if (!frameCaptured) {
			blurRan = false;
			return;
		}
		if (EclipseHud.motionBlur() && EclipseHud.motionBlurPlayers()) {
			blurCurrentFrame(client);
		}

		previousModelView.set(modelView);
		previousProjection.set(projection);
		previousCameraX = cameraX;
		previousCameraY = cameraY;
		previousCameraZ = cameraZ;
		previousFrameReady = true;
		frameCaptured = false;
	}

	public static void onSettingChanged() {
		resetHistory();
	}

	/** Forget previous-frame state; the next frame re-seeds it. */
	public static void resetHistory() {
		previousFrameReady = false;
		frameCaptured = false;
		blurRan = false;
	}

	public static boolean hasHistory() {
		return blurRan;
	}

	private static void blurCurrentFrame(Minecraft client) {
		if (!frameCaptured || !previousFrameReady) {
			return;
		}
		if (client.level == null || client.player == null) {
			return;
		}
		renderBlur(client);
	}

	private static void renderBlur(Minecraft client) {
		RenderTarget main = client.getMainRenderTarget();
		GpuTexture color = main.getColorTexture();
		GpuTextureView colorView = main.getColorTextureView();
		GpuTextureView depthView = main.getDepthTextureView();
		if (color == null || colorView == null || depthView == null) {
			return;
		}

		int width = main.width;
		int height = main.height;
		GpuDevice device = RenderSystem.getDevice();
		CommandEncoder encoder = device.createCommandEncoder();

		if (blurTarget == null || blurTarget.getWidth(0) != width || blurTarget.getHeight(0) != height) {
			closeTarget();
			blurTarget = device.createTexture(
				() -> "Eclipse motion blur target",
				GpuTexture.USAGE_RENDER_ATTACHMENT | GpuTexture.USAGE_TEXTURE_BINDING,
				TextureFormat.RGBA8, width, height, 1, 1
			);
			blurTargetView = device.createTextureView(blurTarget);
		}
		if (uniformBuffer == null) {
			uniformBuffer = new MappableRingBuffer(
				() -> "Eclipse motion blur uniforms",
				GpuBuffer.USAGE_UNIFORM | GpuBuffer.USAGE_MAP_WRITE, UBO_SIZE
			);
		}

		modelViewInverse.set(modelView).invert();
		projectionInverse.set(projection).invert();

		boolean firstPersonOnFoot = client.options.getCameraType().isFirstPerson()
			&& (client.player == null || !client.player.isPassenger());

		try (GpuBuffer.MappedView mapped = encoder.mapBuffer(uniformBuffer.currentBuffer(), false, true)) {
			Std140Builder.intoBuffer(mapped.data())
				.putMat4f(modelViewInverse)
				.putMat4f(projectionInverse)
				.putMat4f(previousModelView)
				.putMat4f(previousProjection)
				.putVec3((float) (cameraX - previousCameraX),
					(float) (cameraY - previousCameraY),
					(float) (cameraZ - previousCameraZ))
				.putVec2(width, height)
				.putFloat(strength())
				.putInt(MAX_SAMPLES)
				.putInt(firstPersonOnFoot ? 0 : 1)
				.putInt(0)
				.putInt(depthSamplingWorks() ? 1 : 0);
		}

		if (!loggedFirstPass) {
			loggedFirstPass = true;
			EclipseHudClient.LOGGER.info(
				"Motion blur pass running: {}x{}, strength={}, backend={}",
				width, height, EclipseHud.motionBlurStrength(), device.getBackendName()
			);
		}

		try (RenderPass pass = encoder.createRenderPass(
			() -> "Eclipse motion blur", blurTargetView, OptionalInt.empty()
		)) {
			pass.setPipeline(PIPELINE);
			RenderSystem.bindDefaultUniforms(pass);
			pass.setUniform("MotionBlurUniforms", uniformBuffer.currentBuffer());
			pass.bindTexture("MainSampler", colorView, RenderSystem.getSamplerCache().getClampToEdge(FilterMode.LINEAR));
			pass.bindTexture("MainDepthSampler", depthView, RenderSystem.getSamplerCache().getClampToEdge(FilterMode.NEAREST));
			pass.draw(0, 3);
		}

		// Blit back through a fullscreen pass. This also works on backends where
		// copyTextureToTexture is missing or a no-op.
		try (RenderPass pass = encoder.createRenderPass(
			() -> "Eclipse motion blur blit", colorView, OptionalInt.empty()
		)) {
			pass.setPipeline(RenderPipelines.TRACY_BLIT);
			RenderSystem.bindDefaultUniforms(pass);
			pass.bindTexture("InSampler", blurTargetView, RenderSystem.getSamplerCache().getClampToEdge(FilterMode.NEAREST));
			pass.draw(0, 3);
		}
		uniformBuffer.rotate();
		blurRan = true;
	}

	private static float strength() {
		return Math.max(0.05F, Math.min(5.0F, EclipseHud.motionBlurStrength() / 20.0F));
	}

	private static boolean depthSamplingWorks() {
		return !VULKANMOD_LOADED;
	}

	private static void closeTarget() {
		if (blurTargetView != null) {
			blurTargetView.close();
			blurTargetView = null;
		}
		if (blurTarget != null) {
			blurTarget.close();
			blurTarget = null;
		}
	}
}
