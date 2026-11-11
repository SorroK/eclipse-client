package com.eclipseclient.hud.mixin;

import com.eclipseclient.hud.EclipseHud;
import net.minecraft.client.multiplayer.PlayerInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerInfo.class)
public abstract class PlayerInfoMixin {
    @Inject(method = "getLatency", at = @At("HEAD"), cancellable = true)
    private void eclipseHud$displayPing(CallbackInfoReturnable<Integer> callback) {
        if (EclipseHud.pingOverride()) {
            callback.setReturnValue(EclipseHud.pingValue());
        }
    }
}
