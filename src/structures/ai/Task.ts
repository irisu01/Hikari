export enum TaskType {
    Unknown = "unknown",
    SearchWeb = "search_internet",
    SearchImages = "search_images",
    SearchResults = "search_results",
    SearchWolframAlpha = "search_wolfram_alpha",
    InternetResults = "internet_results",
    ViewWebsite = "view_website",
    DeleteMessage = "delete_message",
    ImageResults = "image_results",
    UploadImage = "upload_image",
    AskQuestion = "ask_question",
    SaveMemory = "save_memory",
    GetMemory = "get_memory",
    MemoryData = "memory_data",
    ActionResponse = "action_response",
}

export interface Task {
    type: TaskType;
    parameters?: any;
}