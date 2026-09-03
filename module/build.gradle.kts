import java.time.Instant

plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "io.github.mhmrdd.isolationpolicy.zygisk"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
    }

    externalNativeBuild {
        ndkBuild {
            path("jni/Android.mk")
        }
    }

    buildTypes {
        // Minimal, low-volume logcat output: only module-load, denylist-hit,
        // and real error/warning events. See isolation_policy.cpp's IP_DEBUG
        // guard for exactly what this cuts.
        release {
            externalNativeBuild {
                ndkBuild {
                    cFlags("-DIP_DEBUG=0")
                }
            }
        }
        // Full, per-call, per-line logcat output for troubleshooting. Much
        // heavier logcat volume than release -- not meant for daily use.
        debug {
            externalNativeBuild {
                ndkBuild {
                    cFlags("-DIP_DEBUG=1")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Packages the compiled .so files + module.prop + webroot into a flashable
// Magisk/KernelSU/APatch module zip under ../out/.
//
// Two flavors are produced, each a fully independent module (different
// module.prop `id`, so both can be flashed side by side if you want to A/B
// them):
//
//   Release -> out/zygisk_isolationpolicy.zip        id=zygisk_isolationpolicy
//   Debug   -> out/zygisk_isolationpolicy-debug.zip   id=zygisk_isolationpolicy_debug
//
// Run AFTER building the matching native variant, e.g.:
//   ./gradlew :module:externalNativeBuildRelease :module:packageZygiskModuleRelease
//   ./gradlew :module:externalNativeBuildDebug   :module:packageZygiskModuleDebug
// ---------------------------------------------------------------------------

data class ZygiskVariant(
    val taskSuffix: String,     // "Release" / "Debug" -- matches the Gradle variant name
    val cxxDirTag: String,      // lowercase tag expected in the intermediates path for this variant
    val moduleId: String,
    val moduleNameSuffix: String,
    val zipFileName: String,
    val descriptionSuffix: String,
)

val zygiskVariants = listOf(
    ZygiskVariant(
        taskSuffix = "Release",
        cxxDirTag = "release",
        moduleId = "zygisk_isolationpolicy",
        moduleNameSuffix = "",
        zipFileName = "zygisk_isolationpolicy.zip",
        descriptionSuffix = " [Release version]",
    ),
    ZygiskVariant(
        taskSuffix = "Debug",
        cxxDirTag = "debug",
        moduleId = "zygisk_isolationpolicy_debug",
        moduleNameSuffix = " [Debug]",
        zipFileName = "zygisk_isolationpolicy-debug.zip",
        descriptionSuffix = " [Debug version]",
    ),
)

zygiskVariants.forEach { variant ->
    val stagingDir = layout.buildDirectory.dir("zygiskModuleStaging${variant.taskSuffix}")

    val stageTask = tasks.register("stageZygiskModule${variant.taskSuffix}") {
        doLast {
            val stagingDirFile = stagingDir.get().asFile
            stagingDirFile.deleteRecursively()
            project.file("flash").copyRecursively(stagingDirFile)

            // Rewrite module.prop for this variant so release and debug are
            // two distinct, independently installable modules.
            val propFile = File(stagingDirFile, "module.prop")
            var propText = propFile.readText()
            propText = propText.replace(
                Regex("^id=.*$", RegexOption.MULTILINE),
                "id=${variant.moduleId}"
            )
            propText = propText.replace(
                Regex("^name=(.*)$", RegexOption.MULTILINE)
            ) { m -> "name=${m.groupValues[1]}${variant.moduleNameSuffix}" }
            propText = propText.replace(
                Regex("^description=(.*)$", RegexOption.MULTILINE)
            ) { m -> "description=${m.groupValues[1]}${variant.descriptionSuffix}" }
            propFile.writeText(propText)

            // Bake build metadata into the WebUI so it can show version/build
            // type/build date without needing any root shell round trip.
            val buildInfoFile = File(stagingDirFile, "webroot/build-info.js")
            val versionLine = Regex("^version=(.*)$", RegexOption.MULTILINE)
                .find(propText)?.groupValues?.get(1)?.trim() ?: "unknown"
            val versionCodeLine = Regex("^versionCode=(.*)$", RegexOption.MULTILINE)
                .find(propText)?.groupValues?.get(1)?.trim() ?: "0"
            val builtAt = Instant.now().toString()
            buildInfoFile.writeText(
                """
                |// Generated at package time by module/build.gradle.kts -- do not edit by hand.
                |window.ISOLATION_POLICY_BUILD = {
                |  moduleId: ${'"'}${variant.moduleId}${'"'},
                |  buildType: ${'"'}${variant.cxxDirTag}${'"'},
                |  version: ${'"'}$versionLine${'"'},
                |  versionCode: $versionCodeLine,
                |  builtAt: ${'"'}$builtAt${'"'}
                |};
                |""".trimMargin()
            )

            val zygiskDir = File(stagingDirFile, "zygisk")
            zygiskDir.mkdirs()

            val intermediatesDir = layout.buildDirectory.dir("intermediates").get().asFile
            if (intermediatesDir.exists()) {
                val abis = listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
                val candidatesByAbi = mutableMapOf<String, MutableList<File>>()

                intermediatesDir.walkTopDown()
                    .filter { it.isFile && it.name == "libisolationpolicy.so" }
                    .forEach { soFile ->
                        // Parent folder name should be the ABI (e.g., arm64-v8a)
                        val abi = soFile.parentFile.name
                        if (abi in abis) {
                            candidatesByAbi.getOrPut(abi) { mutableListOf() }.add(soFile)
                        }
                    }

                for (abi in abis) {
                    val candidates = candidatesByAbi[abi] ?: continue
                    // Prefer a .so whose path clearly belongs to this variant
                    // (a path segment case-insensitively equal to "release"/
                    // "debug") -- AGP's exact intermediates layout varies by
                    // version, so we match on the tag rather than a fixed path.
                    val tagged = candidates.filter { f ->
                        f.path.split(File.separatorChar).any {
                            it.equals(variant.cxxDirTag, ignoreCase = true)
                        }
                    }
                    val chosen = (tagged.ifEmpty { candidates }).maxByOrNull { it.lastModified() }
                    if (chosen != null) {
                        if (tagged.isEmpty()) {
                            logger.warn(
                                "packageZygiskModule${variant.taskSuffix}: could not find a " +
                                "${variant.taskSuffix}-tagged libisolationpolicy.so for $abi, " +
                                "falling back to most recently built one (${chosen.path}). " +
                                "Make sure :module:externalNativeBuild${variant.taskSuffix} ran first."
                            )
                        }
                        chosen.copyTo(File(zygiskDir, "$abi.so"), overwrite = true)
                    } else {
                        logger.warn("packageZygiskModule${variant.taskSuffix}: no libisolationpolicy.so found for ABI $abi")
                    }
                }
            }
        }
    }

    tasks.register<Zip>("packageZygiskModule${variant.taskSuffix}") {
        dependsOn(stageTask)
        from(stagingDir)
        archiveFileName.set(variant.zipFileName)
        destinationDirectory.set(layout.buildDirectory.dir("../../out"))
    }
}
