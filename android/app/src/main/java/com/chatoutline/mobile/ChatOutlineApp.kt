package com.chatoutline.mobile

import android.app.Application
import com.chatoutline.mobile.data.PromptRepository

class ChatOutlineApp : Application() {
    override fun onCreate() {
        super.onCreate()
        PromptRepository.init(this)
    }
}
