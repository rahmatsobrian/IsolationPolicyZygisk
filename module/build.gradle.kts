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
}

// ---------------------------------------------------------------------------
// Packages the compiled .so files + module.prop + webroot into a flashable
// Magisk/KernelSU/APatch module zip under ../out/.
//
// Run AFTER building the native libs, e.g.:
//   ./gradlew :module:externalNativeBuildRelease
//   ./gradlew :module:packageZygiskModule
// ---------------------------------------------------------------------------
val moduleId = "zygisk_isolationpolicy"
val stagingDir = layout.buildDirectory.dir("zygiskModuleStaging")

tasks.register("stageZygiskModule") {
    val stagingDirFile = stagingDir.get().asFile
    
    doLast {
        stagingDirFile.deleteRecursively()
        project.file("flash").copyRecursively(stagingDirFile)
        
        val zygiskDir = File(stagingDirFile, "zygisk")
        zygiskDir.mkdirs()
        
        val intermediatesDir = layout.buildDirectory.dir("intermediates").get().asFile
        if (intermediatesDir.exists()) {
            intermediatesDir.walkTopDown()
                .filter { it.isFile && it.name == "libisolationpolicy.so" }
                .forEach { soFile ->
                    // Parent folder name should be the ABI (e.g., arm64-v8a)
                    val abi = soFile.parentFile.name
                    // We only care about standard ABIs
                    if (abi in listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")) {
                        val destination = File(zygiskDir, "$abi.so")
                        // Only copy if it doesn't exist, to avoid overwriting stripped with unstripped if they both match,
                        // assuming we process stripped first or just want the first match.
                        // Actually, to be safe we can just overwrite.
                        soFile.copyTo(destination, overwrite = true)
                    }
                }
        }
    }
}

tasks.register<Zip>("packageZygiskModule") {
    dependsOn("stageZygiskModule")
    from(stagingDir)
    archiveFileName.set("$moduleId.zip")
    destinationDirectory.set(layout.buildDirectory.dir("../../out"))
}
