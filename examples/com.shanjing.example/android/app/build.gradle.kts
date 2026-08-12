plugins {
    id("com.android.application")
}

android {
    namespace = "com.shanjing.example"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.shanjing.example"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.lynxsdk.lynx:lynx:4.0.0")
    implementation("org.lynxsdk.lynx:lynx-jssdk:4.0.0")
    implementation("org.lynxsdk.lynx:primjs:4.0.0")
}

